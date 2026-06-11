import { randomUUID } from 'node:crypto';
import {
  ensureFreshGoogleCalendarProfile,
  getRequiredGoogleCalendarProfile,
  googleCalendarAuthStore,
  refreshGoogleCalendarProfile,
  resolveOAuthClientConfig,
} from './auth.js';
import type { GoogleCalendarProfile } from './auth-store.js';

const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');
const CALENDAR_API_BASE_URL = 'https://www.googleapis.com/calendar/v3';

export interface GoogleCalendarDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface GoogleCalendarAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  optional?: boolean;
  organizer?: boolean;
  resource?: boolean;
  self?: boolean;
  [key: string]: unknown;
}

export interface GoogleCalendarEntry {
  id: string;
  summary?: string;
  description?: string;
  timeZone?: string;
  location?: string;
  primary?: boolean;
  accessRole?: string;
  htmlLink?: string;
  kind?: string;
  [key: string]: unknown;
}

export interface GoogleCalendarEvent {
  id: string;
  calendarId?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  htmlLink?: string;
  start?: GoogleCalendarDateTime;
  end?: GoogleCalendarDateTime;
  attendees?: GoogleCalendarAttendee[];
  recurringEventId?: string;
  recurrence?: string[];
  [key: string]: unknown;
}

export interface GoogleCalendarAclRule {
  id: string;
  role?: string;
  scope?: { type?: string; value?: string };
  [key: string]: unknown;
}

export interface GoogleCalendarSetting {
  id: string;
  value?: string;
  [key: string]: unknown;
}

export type GoogleCalendarListResult<T> = T[] & {
  items: T[];
  nextPageToken?: string;
  nextSyncToken?: string;
  summary?: string;
  timeZone?: string;
  accessRole?: string;
  etag?: string;
};

export interface GoogleCalendarRequestOptions {
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  baseUrl?: string;
}

type EventDateTimeInput = string | Date | GoogleCalendarDateTime;
type EventInput = Record<string, unknown> & {
  summary?: string;
  description?: string;
  location?: string;
  start?: EventDateTimeInput;
  end?: EventDateTimeInput;
  allDay?: boolean;
  attendees?: Array<string | GoogleCalendarAttendee>;
  meet?: boolean | {
    requestId?: string;
    conferenceSolutionKeyType?: string;
  };
};

type QueryValue = string | number | boolean | Date | Array<string | number | boolean | Date> | undefined | null;

function normalizeCalendarId(calendarId?: string): string {
  return String(calendarId || 'primary').trim() || 'primary';
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function normalizeDateTimeInput(value: EventDateTimeInput | undefined, allDay: boolean): GoogleCalendarDateTime | undefined {
  if (!value) {
    return undefined;
  }

  if (value instanceof Date) {
    return allDay
      ? { date: value.toISOString().slice(0, 10) }
      : { dateTime: value.toISOString() };
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    if (allDay) {
      return { date: trimmed.slice(0, 10) };
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return { date: trimmed };
    }
    return { dateTime: trimmed };
  }

  const next = { ...value };
  if (allDay && next.dateTime && !next.date) {
    next.date = String(next.dateTime).slice(0, 10);
    delete next.dateTime;
  }
  return next;
}

function normalizeAttendees(attendees?: Array<string | GoogleCalendarAttendee>): GoogleCalendarAttendee[] | undefined {
  if (!Array.isArray(attendees)) {
    return undefined;
  }
  return attendees
    .map((item) => typeof item === 'string' ? { email: item } : item)
    .filter((item): item is GoogleCalendarAttendee => Boolean(item && item.email));
}

function normalizeEventBody(input: EventInput): { body: Record<string, unknown>; conferenceDataVersion?: number } {
  const body: Record<string, unknown> = { ...input };
  const allDay = Boolean(input.allDay);

  if ('start' in input) {
    body.start = normalizeDateTimeInput(input.start, allDay);
  }
  if ('end' in input) {
    body.end = normalizeDateTimeInput(input.end, allDay);
  }

  const attendees = normalizeAttendees(input.attendees);
  if (attendees) {
    body.attendees = attendees;
  }

  let conferenceDataVersion: number | undefined;
  if (input.meet) {
    const meet = typeof input.meet === 'object' ? input.meet : {};
    body.conferenceData = {
      createRequest: {
        requestId: String(meet.requestId || randomUUID()),
        conferenceSolutionKey: {
          type: String(meet.conferenceSolutionKeyType || 'hangoutsMeet'),
        },
      },
    };
    conferenceDataVersion = 1;
  }

  delete body.allDay;
  delete body.meet;
  return { body, conferenceDataVersion };
}

function normalizeQueryValue(value: QueryValue): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeQueryValue(item as QueryValue));
  }
  if (value instanceof Date) {
    return [value.toISOString()];
  }
  return [String(value)];
}

function buildUrl(baseUrl: string, pathName: string, query?: Record<string, unknown>): string {
  const url = new URL(pathName.replace(/^\//, ''), `${baseUrl.replace(/\/+$/, '')}/`);
  for (const [key, value] of Object.entries(query || {})) {
    for (const normalized of normalizeQueryValue(value as QueryValue)) {
      url.searchParams.append(key, normalized);
    }
  }
  return url.toString();
}

async function parseJsonSafe(response: Response): Promise<any> {
  if (response.status === 204) {
    return null;
  }
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function getApiErrorMessage(payload: any, fallback: string): string {
  if (typeof payload === 'string' && payload.trim()) {
    return payload.trim();
  }
  const message = payload?.error?.message || payload?.message;
  if (typeof message === 'string' && message.trim()) {
    return message.trim();
  }
  return fallback;
}

async function doGoogleCalendarRequest<T = unknown>(
  profile: GoogleCalendarProfile,
  method: string,
  pathName: string,
  options: GoogleCalendarRequestOptions = {},
  allowRefreshRetry = true,
): Promise<T> {
  const url = buildUrl(options.baseUrl || CALENDAR_API_BASE_URL, pathName, options.query);
  const hasJsonBody = options.body !== undefined;
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${profile.accessToken}`,
      ...(hasJsonBody ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    body: hasJsonBody ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 401 && allowRefreshRetry && profile.refreshToken) {
    const refreshed = await refreshGoogleCalendarProfile(profile);
    return doGoogleCalendarRequest<T>(refreshed, method, pathName, options, false);
  }

  const payload = await parseJsonSafe(response);
  if (!response.ok) {
    throw new Error(getApiErrorMessage(payload, `Google Calendar API request failed: ${response.status}`));
  }

  return payload as T;
}

async function requestGoogleCalendar<T = unknown>(
  method: string,
  pathName: string,
  options: GoogleCalendarRequestOptions = {},
): Promise<T> {
  const profile = await ensureFreshGoogleCalendarProfile();
  return doGoogleCalendarRequest<T>(profile, method, pathName, options);
}

async function requestGoogleCalendarVoid(
  method: string,
  pathName: string,
  options: GoogleCalendarRequestOptions = {},
): Promise<{ ok: true }> {
  await requestGoogleCalendar(method, pathName, options);
  return { ok: true };
}

function decorateEvent(event: GoogleCalendarEvent, calendarId: string): GoogleCalendarEvent {
  return {
    ...event,
    calendarId: event.calendarId || calendarId,
  };
}

function toListResult<T>(payload: any, mapItem: (item: any) => T): GoogleCalendarListResult<T> {
  const items = Array.isArray(payload?.items) ? payload.items.map(mapItem) : [];
  return Object.assign(items, {
    items,
    nextPageToken: typeof payload?.nextPageToken === 'string' ? payload.nextPageToken : undefined,
    nextSyncToken: typeof payload?.nextSyncToken === 'string' ? payload.nextSyncToken : undefined,
    summary: typeof payload?.summary === 'string' ? payload.summary : undefined,
    timeZone: typeof payload?.timeZone === 'string' ? payload.timeZone : undefined,
    accessRole: typeof payload?.accessRole === 'string' ? payload.accessRole : undefined,
    etag: typeof payload?.etag === 'string' ? payload.etag : undefined,
  }) as GoogleCalendarListResult<T>;
}

class GoogleCalendarHandle {
  readonly id: string;
  readonly summary?: string;
  readonly description?: string;
  readonly timeZone?: string;
  readonly primary?: boolean;
  readonly accessRole?: string;
  readonly raw: GoogleCalendarEntry;

  constructor(calendar: GoogleCalendarEntry) {
    this.id = String(calendar.id);
    this.summary = typeof calendar.summary === 'string' ? calendar.summary : undefined;
    this.description = typeof calendar.description === 'string' ? calendar.description : undefined;
    this.timeZone = typeof calendar.timeZone === 'string' ? calendar.timeZone : undefined;
    this.primary = Boolean(calendar.primary);
    this.accessRole = typeof calendar.accessRole === 'string' ? calendar.accessRole : undefined;
    this.raw = calendar;
  }

  toJSON() {
    return {
      kind: 'googleCalendar.calendar',
      ...this.raw,
    };
  }

  [INSPECT_CUSTOM]() {
    return this.toJSON();
  }

  async get(): Promise<GoogleCalendarHandle> {
    return getCalendar(this.id);
  }

  async update(body: Record<string, unknown>): Promise<GoogleCalendarHandle> {
    return updateCalendar(this.id, body);
  }

  async patch(body: Record<string, unknown>): Promise<GoogleCalendarHandle> {
    return patchCalendar(this.id, body);
  }

  async delete() {
    return deleteCalendar(this.id);
  }

  async clear() {
    return clearCalendar(this.id);
  }

  readonly events = {
    list: (options?: Record<string, unknown>) => listEvents(this.id, options),
    upcoming: (options?: Record<string, unknown>) => upcomingEvents(this.id, options),
    get: (eventId: string, options?: Record<string, unknown>) => getEvent(this.id, eventId, options),
    create: (event: EventInput, options?: Record<string, unknown>) => createEvent(this.id, event, options),
  };

  readonly acl = {
    list: (options?: Record<string, unknown>) => listAclRules(this.id, options),
    create: (rule: Record<string, unknown>, options?: Record<string, unknown>) => createAclRule(this.id, rule, options),
  };
}

class GoogleCalendarEventHandle {
  readonly id: string;
  readonly calendarId: string;
  readonly summary?: string;
  readonly description?: string;
  readonly status?: string;
  readonly htmlLink?: string;
  readonly start?: GoogleCalendarDateTime;
  readonly end?: GoogleCalendarDateTime;
  readonly attendees?: GoogleCalendarAttendee[];
  readonly raw: GoogleCalendarEvent;

  constructor(event: GoogleCalendarEvent) {
    this.id = String(event.id);
    this.calendarId = normalizeCalendarId(event.calendarId);
    this.summary = typeof event.summary === 'string' ? event.summary : undefined;
    this.description = typeof event.description === 'string' ? event.description : undefined;
    this.status = typeof event.status === 'string' ? event.status : undefined;
    this.htmlLink = typeof event.htmlLink === 'string' ? event.htmlLink : undefined;
    this.start = event.start;
    this.end = event.end;
    this.attendees = Array.isArray(event.attendees) ? event.attendees : undefined;
    this.raw = event;
  }

  toJSON() {
    return {
      kind: 'googleCalendar.event',
      ...this.raw,
    };
  }

  [INSPECT_CUSTOM]() {
    return this.toJSON();
  }

  async get(options?: Record<string, unknown>): Promise<GoogleCalendarEventHandle> {
    return getEvent(this.calendarId, this.id, options);
  }

  async update(body: EventInput, options?: Record<string, unknown>): Promise<GoogleCalendarEventHandle> {
    return updateEvent(this.calendarId, this.id, body, options);
  }

  async patch(body: EventInput, options?: Record<string, unknown>): Promise<GoogleCalendarEventHandle> {
    return patchEvent(this.calendarId, this.id, body, options);
  }

  async delete(options?: Record<string, unknown>) {
    return deleteEvent(this.calendarId, this.id, options);
  }

  async move(destinationCalendarId: string, options?: Record<string, unknown>): Promise<GoogleCalendarEventHandle> {
    return moveEvent(this.calendarId, this.id, destinationCalendarId, options);
  }

  async cancel(options?: Record<string, unknown>): Promise<GoogleCalendarEventHandle> {
    return patchEvent(this.calendarId, this.id, { status: 'cancelled' }, options);
  }

  async instances(options?: Record<string, unknown>) {
    return listEventInstances(this.calendarId, this.id, options);
  }
}

function toCalendarHandle(calendar: GoogleCalendarEntry): GoogleCalendarHandle {
  return new GoogleCalendarHandle(calendar);
}

function toEventHandle(event: GoogleCalendarEvent): GoogleCalendarEventHandle {
  return new GoogleCalendarEventHandle(event);
}

async function getCalendar(calendarId = 'primary'): Promise<GoogleCalendarHandle> {
  const payload = await requestGoogleCalendar<GoogleCalendarEntry>('GET', `/calendars/${encodePathSegment(normalizeCalendarId(calendarId))}`);
  return toCalendarHandle(payload);
}

async function createCalendar(body: Record<string, unknown>): Promise<GoogleCalendarHandle> {
  const payload = await requestGoogleCalendar<GoogleCalendarEntry>('POST', '/calendars', { body });
  return toCalendarHandle(payload);
}

async function updateCalendar(calendarId: string, body: Record<string, unknown>): Promise<GoogleCalendarHandle> {
  const payload = await requestGoogleCalendar<GoogleCalendarEntry>('PUT', `/calendars/${encodePathSegment(normalizeCalendarId(calendarId))}`, { body });
  return toCalendarHandle(payload);
}

async function patchCalendar(calendarId: string, body: Record<string, unknown>): Promise<GoogleCalendarHandle> {
  const payload = await requestGoogleCalendar<GoogleCalendarEntry>('PATCH', `/calendars/${encodePathSegment(normalizeCalendarId(calendarId))}`, { body });
  return toCalendarHandle(payload);
}

async function deleteCalendar(calendarId: string) {
  return requestGoogleCalendarVoid('DELETE', `/calendars/${encodePathSegment(normalizeCalendarId(calendarId))}`);
}

async function clearCalendar(calendarId: string) {
  return requestGoogleCalendarVoid('POST', `/calendars/${encodePathSegment(normalizeCalendarId(calendarId))}/clear`);
}

async function listCalendarList(options?: Record<string, unknown>): Promise<GoogleCalendarListResult<GoogleCalendarHandle>> {
  const payload = await requestGoogleCalendar<any>('GET', '/users/me/calendarList', { query: options });
  return toListResult(payload, (item) => toCalendarHandle(item as GoogleCalendarEntry));
}

async function getCalendarListEntry(calendarId = 'primary'): Promise<GoogleCalendarHandle> {
  const payload = await requestGoogleCalendar<GoogleCalendarEntry>('GET', `/users/me/calendarList/${encodePathSegment(normalizeCalendarId(calendarId))}`);
  return toCalendarHandle(payload);
}

async function insertCalendarListEntry(body: Record<string, unknown>): Promise<GoogleCalendarHandle> {
  const payload = await requestGoogleCalendar<GoogleCalendarEntry>('POST', '/users/me/calendarList', { body });
  return toCalendarHandle(payload);
}

async function updateCalendarListEntry(calendarId: string, body: Record<string, unknown>): Promise<GoogleCalendarHandle> {
  const payload = await requestGoogleCalendar<GoogleCalendarEntry>('PUT', `/users/me/calendarList/${encodePathSegment(normalizeCalendarId(calendarId))}`, { body });
  return toCalendarHandle(payload);
}

async function patchCalendarListEntry(calendarId: string, body: Record<string, unknown>): Promise<GoogleCalendarHandle> {
  const payload = await requestGoogleCalendar<GoogleCalendarEntry>('PATCH', `/users/me/calendarList/${encodePathSegment(normalizeCalendarId(calendarId))}`, { body });
  return toCalendarHandle(payload);
}

async function deleteCalendarListEntry(calendarId: string) {
  return requestGoogleCalendarVoid('DELETE', `/users/me/calendarList/${encodePathSegment(normalizeCalendarId(calendarId))}`);
}

async function createWatch(pathName: string, body: Record<string, unknown>, query?: Record<string, unknown>) {
  return requestGoogleCalendar('POST', `${pathName}/watch`, { body, query });
}

async function listEvents(calendarId = 'primary', options?: Record<string, unknown>): Promise<GoogleCalendarListResult<GoogleCalendarEventHandle>> {
  const normalizedCalendarId = normalizeCalendarId(calendarId);
  const payload = await requestGoogleCalendar<any>(
    'GET',
    `/calendars/${encodePathSegment(normalizedCalendarId)}/events`,
    { query: options },
  );
  return toListResult(payload, (item) => toEventHandle(decorateEvent(item as GoogleCalendarEvent, normalizedCalendarId)));
}

async function upcomingEvents(calendarId = 'primary', options?: Record<string, unknown>) {
  return listEvents(calendarId, {
    singleEvents: true,
    orderBy: 'startTime',
    timeMin: new Date().toISOString(),
    maxResults: 10,
    ...(options || {}),
  });
}

async function findEvents(query: string, calendarId = 'primary', options?: Record<string, unknown>) {
  return listEvents(calendarId, {
    q: query,
    singleEvents: true,
    ...(options || {}),
  });
}

async function getEvent(calendarId = 'primary', eventId: string, options?: Record<string, unknown>): Promise<GoogleCalendarEventHandle> {
  const normalizedCalendarId = normalizeCalendarId(calendarId);
  const payload = await requestGoogleCalendar<GoogleCalendarEvent>(
    'GET',
    `/calendars/${encodePathSegment(normalizedCalendarId)}/events/${encodePathSegment(String(eventId))}`,
    { query: options },
  );
  return toEventHandle(decorateEvent(payload, normalizedCalendarId));
}

async function createEvent(calendarId = 'primary', event: EventInput, options?: Record<string, unknown>): Promise<GoogleCalendarEventHandle> {
  const normalizedCalendarId = normalizeCalendarId(calendarId);
  const normalized = normalizeEventBody(event);
  const payload = await requestGoogleCalendar<GoogleCalendarEvent>(
    'POST',
    `/calendars/${encodePathSegment(normalizedCalendarId)}/events`,
    {
      query: {
        ...(options || {}),
        ...(normalized.conferenceDataVersion ? { conferenceDataVersion: normalized.conferenceDataVersion } : {}),
      },
      body: normalized.body,
    },
  );
  return toEventHandle(decorateEvent(payload, normalizedCalendarId));
}

async function quickAddEvent(calendarId = 'primary', text: string, options?: Record<string, unknown>): Promise<GoogleCalendarEventHandle> {
  const normalizedCalendarId = normalizeCalendarId(calendarId);
  const payload = await requestGoogleCalendar<GoogleCalendarEvent>(
    'POST',
    `/calendars/${encodePathSegment(normalizedCalendarId)}/events/quickAdd`,
    {
      query: {
        text,
        ...(options || {}),
      },
    },
  );
  return toEventHandle(decorateEvent(payload, normalizedCalendarId));
}

async function importEvent(calendarId = 'primary', event: Record<string, unknown>, options?: Record<string, unknown>): Promise<GoogleCalendarEventHandle> {
  const normalizedCalendarId = normalizeCalendarId(calendarId);
  const payload = await requestGoogleCalendar<GoogleCalendarEvent>(
    'POST',
    `/calendars/${encodePathSegment(normalizedCalendarId)}/events/import`,
    {
      body: event,
      query: options,
    },
  );
  return toEventHandle(decorateEvent(payload, normalizedCalendarId));
}

async function updateEvent(calendarId = 'primary', eventId: string, event: EventInput, options?: Record<string, unknown>): Promise<GoogleCalendarEventHandle> {
  const normalizedCalendarId = normalizeCalendarId(calendarId);
  const normalized = normalizeEventBody(event);
  const payload = await requestGoogleCalendar<GoogleCalendarEvent>(
    'PUT',
    `/calendars/${encodePathSegment(normalizedCalendarId)}/events/${encodePathSegment(String(eventId))}`,
    {
      query: {
        ...(options || {}),
        ...(normalized.conferenceDataVersion ? { conferenceDataVersion: normalized.conferenceDataVersion } : {}),
      },
      body: normalized.body,
    },
  );
  return toEventHandle(decorateEvent(payload, normalizedCalendarId));
}

async function patchEvent(calendarId = 'primary', eventId: string, event: EventInput, options?: Record<string, unknown>): Promise<GoogleCalendarEventHandle> {
  const normalizedCalendarId = normalizeCalendarId(calendarId);
  const normalized = normalizeEventBody(event);
  const payload = await requestGoogleCalendar<GoogleCalendarEvent>(
    'PATCH',
    `/calendars/${encodePathSegment(normalizedCalendarId)}/events/${encodePathSegment(String(eventId))}`,
    {
      query: {
        ...(options || {}),
        ...(normalized.conferenceDataVersion ? { conferenceDataVersion: normalized.conferenceDataVersion } : {}),
      },
      body: normalized.body,
    },
  );
  return toEventHandle(decorateEvent(payload, normalizedCalendarId));
}

async function deleteEvent(calendarId = 'primary', eventId: string, options?: Record<string, unknown>) {
  return requestGoogleCalendarVoid(
    'DELETE',
    `/calendars/${encodePathSegment(normalizeCalendarId(calendarId))}/events/${encodePathSegment(String(eventId))}`,
    { query: options },
  );
}

async function moveEvent(calendarId = 'primary', eventId: string, destinationCalendarId: string, options?: Record<string, unknown>): Promise<GoogleCalendarEventHandle> {
  const payload = await requestGoogleCalendar<GoogleCalendarEvent>(
    'POST',
    `/calendars/${encodePathSegment(normalizeCalendarId(calendarId))}/events/${encodePathSegment(String(eventId))}/move`,
    {
      query: {
        destination: normalizeCalendarId(destinationCalendarId),
        ...(options || {}),
      },
    },
  );
  return toEventHandle(decorateEvent(payload, normalizeCalendarId(destinationCalendarId)));
}

async function listEventInstances(calendarId = 'primary', eventId: string, options?: Record<string, unknown>) {
  const normalizedCalendarId = normalizeCalendarId(calendarId);
  const payload = await requestGoogleCalendar<any>(
    'GET',
    `/calendars/${encodePathSegment(normalizedCalendarId)}/events/${encodePathSegment(String(eventId))}/instances`,
    { query: options },
  );
  return toListResult(payload, (item) => toEventHandle(decorateEvent(item as GoogleCalendarEvent, normalizedCalendarId)));
}

async function listAclRules(calendarId = 'primary', options?: Record<string, unknown>): Promise<GoogleCalendarListResult<GoogleCalendarAclRule>> {
  const payload = await requestGoogleCalendar<any>(
    'GET',
    `/calendars/${encodePathSegment(normalizeCalendarId(calendarId))}/acl`,
    { query: options },
  );
  return toListResult(payload, (item) => item as GoogleCalendarAclRule);
}

async function getAclRule(calendarId = 'primary', ruleId: string): Promise<GoogleCalendarAclRule> {
  return requestGoogleCalendar<GoogleCalendarAclRule>(
    'GET',
    `/calendars/${encodePathSegment(normalizeCalendarId(calendarId))}/acl/${encodePathSegment(String(ruleId))}`,
  );
}

async function createAclRule(calendarId = 'primary', rule: Record<string, unknown>, options?: Record<string, unknown>): Promise<GoogleCalendarAclRule> {
  return requestGoogleCalendar<GoogleCalendarAclRule>(
    'POST',
    `/calendars/${encodePathSegment(normalizeCalendarId(calendarId))}/acl`,
    { body: rule, query: options },
  );
}

async function updateAclRule(calendarId = 'primary', ruleId: string, rule: Record<string, unknown>, options?: Record<string, unknown>): Promise<GoogleCalendarAclRule> {
  return requestGoogleCalendar<GoogleCalendarAclRule>(
    'PUT',
    `/calendars/${encodePathSegment(normalizeCalendarId(calendarId))}/acl/${encodePathSegment(String(ruleId))}`,
    { body: rule, query: options },
  );
}

async function patchAclRule(calendarId = 'primary', ruleId: string, rule: Record<string, unknown>, options?: Record<string, unknown>): Promise<GoogleCalendarAclRule> {
  return requestGoogleCalendar<GoogleCalendarAclRule>(
    'PATCH',
    `/calendars/${encodePathSegment(normalizeCalendarId(calendarId))}/acl/${encodePathSegment(String(ruleId))}`,
    { body: rule, query: options },
  );
}

async function deleteAclRule(calendarId = 'primary', ruleId: string) {
  return requestGoogleCalendarVoid(
    'DELETE',
    `/calendars/${encodePathSegment(normalizeCalendarId(calendarId))}/acl/${encodePathSegment(String(ruleId))}`,
  );
}

async function listSettings(options?: Record<string, unknown>): Promise<GoogleCalendarListResult<GoogleCalendarSetting>> {
  const payload = await requestGoogleCalendar<any>('GET', '/users/me/settings', { query: options });
  return toListResult(payload, (item) => item as GoogleCalendarSetting);
}

async function getSetting(settingId: string): Promise<GoogleCalendarSetting> {
  return requestGoogleCalendar<GoogleCalendarSetting>('GET', `/users/me/settings/${encodePathSegment(String(settingId))}`);
}

async function getColors() {
  return requestGoogleCalendar('GET', '/colors');
}

async function queryFreeBusy(body: Record<string, unknown>) {
  return requestGoogleCalendar('POST', '/freeBusy', { body });
}

async function stopChannel(body: Record<string, unknown>) {
  return requestGoogleCalendar('POST', '/channels/stop', { body });
}

async function rawRequest(method: string, pathName: string, options?: GoogleCalendarRequestOptions) {
  return requestGoogleCalendar(method.toUpperCase(), pathName, options);
}

export const googleCalendarService = {
  authStore: googleCalendarAuthStore,
  ensureProfile: getRequiredGoogleCalendarProfile,
  ensureFreshProfile: ensureFreshGoogleCalendarProfile,
  resolveOAuthClientConfig,
  request: rawRequest,
  calendars: {
    list: listCalendarList,
    get: getCalendar,
    primary: () => getCalendar('primary'),
    create: createCalendar,
    update: updateCalendar,
    patch: patchCalendar,
    delete: deleteCalendar,
    clear: clearCalendar,
    watch: (body: Record<string, unknown>, options?: Record<string, unknown>) => createWatch('/users/me/calendarList', body, options),
  },
  calendarList: {
    list: listCalendarList,
    get: getCalendarListEntry,
    insert: insertCalendarListEntry,
    create: insertCalendarListEntry,
    update: updateCalendarListEntry,
    patch: patchCalendarListEntry,
    delete: deleteCalendarListEntry,
    watch: (body: Record<string, unknown>, options?: Record<string, unknown>) => createWatch('/users/me/calendarList', body, options),
  },
  events: {
    list: listEvents,
    upcoming: upcomingEvents,
    find: findEvents,
    get: getEvent,
    create: createEvent,
    insert: createEvent,
    quickAdd: quickAddEvent,
    import: importEvent,
    update: updateEvent,
    patch: patchEvent,
    delete: deleteEvent,
    move: moveEvent,
    instances: listEventInstances,
    watch: (calendarId = 'primary', body: Record<string, unknown>, options?: Record<string, unknown>) => {
      return createWatch(`/calendars/${encodePathSegment(normalizeCalendarId(calendarId))}/events`, body, options);
    },
  },
  acl: {
    list: listAclRules,
    get: getAclRule,
    create: createAclRule,
    insert: createAclRule,
    update: updateAclRule,
    patch: patchAclRule,
    delete: deleteAclRule,
    watch: (calendarId = 'primary', body: Record<string, unknown>, options?: Record<string, unknown>) => {
      return createWatch(`/calendars/${encodePathSegment(normalizeCalendarId(calendarId))}/acl`, body, options);
    },
  },
  settings: {
    list: listSettings,
    get: getSetting,
    watch: (body: Record<string, unknown>, options?: Record<string, unknown>) => createWatch('/users/me/settings', body, options),
  },
  colors: {
    get: getColors,
  },
  freeBusy: {
    query: queryFreeBusy,
  },
  channels: {
    stop: stopChannel,
  },
};

export {
  GoogleCalendarHandle,
  GoogleCalendarEventHandle,
  createCalendar,
  getCalendar,
  updateCalendar,
  patchCalendar,
  deleteCalendar,
  clearCalendar,
  listCalendarList,
  getCalendarListEntry,
  insertCalendarListEntry,
  updateCalendarListEntry,
  patchCalendarListEntry,
  deleteCalendarListEntry,
  listEvents,
  upcomingEvents,
  findEvents,
  getEvent,
  createEvent,
  quickAddEvent,
  importEvent,
  updateEvent,
  patchEvent,
  deleteEvent,
  moveEvent,
  listEventInstances,
  listAclRules,
  getAclRule,
  createAclRule,
  updateAclRule,
  patchAclRule,
  deleteAclRule,
  listSettings,
  getSetting,
  getColors,
  queryFreeBusy,
  stopChannel,
  rawRequest as requestGoogleCalendarApi,
};
