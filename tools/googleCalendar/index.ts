import {
  configureGoogleCalendarClient,
  getGoogleCalendarAuthStatus,
  getGoogleCalendarClientConfigSummary,
  listGoogleCalendarProfiles,
  loginGoogleCalendar,
  logoutGoogleCalendar,
  useGoogleCalendarProfile,
} from '../../src/google_calendar/auth.js';
import {
  googleCalendarService,
  type GoogleCalendarRequestOptions,
} from '../../src/google_calendar/service.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCalendarId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function resolveCalendarAndOptions(
  calendarIdOrOptions?: string | Record<string, unknown> | null,
  options?: Record<string, unknown>,
): { calendarId: string; options?: Record<string, unknown> } {
  if (!isCalendarId(calendarIdOrOptions)) {
    return {
      calendarId: 'primary',
      options: isRecord(calendarIdOrOptions) ? calendarIdOrOptions : options,
    };
  }

  return {
    calendarId: calendarIdOrOptions,
    options,
  };
}

function resolveCalendarEventAndOptions(
  first?: string | Record<string, unknown> | null,
  second?: string | Record<string, unknown>,
  third?: Record<string, unknown>,
): { calendarId: string; eventId: string; options?: Record<string, unknown> } {
  if (isCalendarId(first) && isCalendarId(second)) {
    return { calendarId: first, eventId: second, options: third };
  }

  if (isCalendarId(first)) {
    return {
      calendarId: 'primary',
      eventId: first,
      options: isRecord(second) ? second : third,
    };
  }

  throw new Error('eventId is required.');
}

function resolveCalendarBodyAndOptions<T extends Record<string, unknown>>(
  first?: string | T | null,
  second?: T | Record<string, unknown>,
  third?: Record<string, unknown>,
): { calendarId: string; body: T; options?: Record<string, unknown> } {
  if (isCalendarId(first)) {
    if (!isRecord(second)) {
      throw new Error('body is required.');
    }
    return { calendarId: first, body: second as T, options: third };
  }

  if (!isRecord(first)) {
    throw new Error('body is required.');
  }

  return {
    calendarId: 'primary',
    body: first as T,
    options: isRecord(second) ? second : third,
  };
}

function resolveCalendarTextAndOptions(
  first?: string | Record<string, unknown> | null,
  second?: string | Record<string, unknown>,
  third?: Record<string, unknown>,
): { calendarId: string; text: string; options?: Record<string, unknown> } {
  if (isCalendarId(first) && typeof second === 'string') {
    return { calendarId: first, text: second, options: third };
  }

  if (typeof first === 'string') {
    return {
      calendarId: 'primary',
      text: first,
      options: isRecord(second) ? second : third,
    };
  }

  throw new Error('text is required.');
}

function resolveCalendarEventMoveArgs(
  first?: string | null,
  second?: string,
  third?: string,
  fourth?: Record<string, unknown>,
): { calendarId: string; eventId: string; destinationCalendarId: string; options?: Record<string, unknown> } {
  if (isCalendarId(first) && isCalendarId(second) && isCalendarId(third)) {
    return { calendarId: first, eventId: second, destinationCalendarId: third, options: fourth };
  }

  if (isCalendarId(first) && isCalendarId(second)) {
    return {
      calendarId: 'primary',
      eventId: first,
      destinationCalendarId: second,
      options: fourth,
    };
  }

  throw new Error('eventId and destinationCalendarId are required.');
}

function resolveWatchArgs(
  first?: string | Record<string, unknown> | null,
  second?: Record<string, unknown>,
  third?: Record<string, unknown>,
): { calendarId: string; channel: Record<string, unknown>; options?: Record<string, unknown> } {
  if (isCalendarId(first)) {
    if (!isRecord(second)) {
      throw new Error('channel body is required.');
    }
    return { calendarId: first, channel: second, options: third };
  }

  if (!isRecord(first)) {
    throw new Error('channel body is required.');
  }

  return {
    calendarId: 'primary',
    channel: first,
    options: second,
  };
}

export const auth = {
  status: getGoogleCalendarAuthStatus,
  login: (force = false) => loginGoogleCalendar(Boolean(force)),
  listProfiles: listGoogleCalendarProfiles,
  use: useGoogleCalendarProfile,
  logout: logoutGoogleCalendar,
  configure: configureGoogleCalendarClient,
  clientConfig: getGoogleCalendarClientConfigSummary,
};

export const calendars = {
  list: googleCalendarService.calendars.list,
  get: googleCalendarService.calendars.get,
  primary: googleCalendarService.calendars.primary,
  create: googleCalendarService.calendars.create,
  update: googleCalendarService.calendars.update,
  patch: googleCalendarService.calendars.patch,
  delete: googleCalendarService.calendars.delete,
  clear: googleCalendarService.calendars.clear,
  watch: googleCalendarService.calendars.watch,
};

export const calendarList = {
  list: googleCalendarService.calendarList.list,
  get: googleCalendarService.calendarList.get,
  insert: googleCalendarService.calendarList.insert,
  create: googleCalendarService.calendarList.create,
  update: googleCalendarService.calendarList.update,
  patch: googleCalendarService.calendarList.patch,
  delete: googleCalendarService.calendarList.delete,
  watch: googleCalendarService.calendarList.watch,
};

export const events = {
  list(calendarIdOrOptions?: string | Record<string, unknown> | null, options?: Record<string, unknown>) {
    const resolved = resolveCalendarAndOptions(calendarIdOrOptions, options);
    return googleCalendarService.events.list(resolved.calendarId, resolved.options);
  },
  upcoming(calendarIdOrOptions?: string | Record<string, unknown> | null, options?: Record<string, unknown>) {
    const resolved = resolveCalendarAndOptions(calendarIdOrOptions, options);
    return googleCalendarService.events.upcoming(resolved.calendarId, resolved.options);
  },
  find(query: string, calendarIdOrOptions?: string | Record<string, unknown> | null, options?: Record<string, unknown>) {
    const resolved = resolveCalendarAndOptions(calendarIdOrOptions, options);
    return googleCalendarService.events.find(query, resolved.calendarId, resolved.options);
  },
  get(first?: string | Record<string, unknown> | null, second?: string | Record<string, unknown>, third?: Record<string, unknown>) {
    const resolved = resolveCalendarEventAndOptions(first, second, third);
    return googleCalendarService.events.get(resolved.calendarId, resolved.eventId, resolved.options);
  },
  create(first?: string | Record<string, unknown> | null, second?: Record<string, unknown>, third?: Record<string, unknown>) {
    const resolved = resolveCalendarBodyAndOptions(first, second, third);
    return googleCalendarService.events.create(resolved.calendarId, resolved.body, resolved.options);
  },
  insert(first?: string | Record<string, unknown> | null, second?: Record<string, unknown>, third?: Record<string, unknown>) {
    const resolved = resolveCalendarBodyAndOptions(first, second, third);
    return googleCalendarService.events.insert(resolved.calendarId, resolved.body, resolved.options);
  },
  quickAdd(first?: string | Record<string, unknown> | null, second?: string | Record<string, unknown>, third?: Record<string, unknown>) {
    const resolved = resolveCalendarTextAndOptions(first, second, third);
    return googleCalendarService.events.quickAdd(resolved.calendarId, resolved.text, resolved.options);
  },
  import(first?: string | Record<string, unknown> | null, second?: Record<string, unknown>, third?: Record<string, unknown>) {
    const resolved = resolveCalendarBodyAndOptions(first, second, third);
    return googleCalendarService.events.import(resolved.calendarId, resolved.body, resolved.options);
  },
  update(first?: string | Record<string, unknown> | null, second?: string | Record<string, unknown>, third?: Record<string, unknown>, fourth?: Record<string, unknown>) {
    const eventRef = resolveCalendarEventAndOptions(first, second, undefined);
    if (!isRecord(third)) {
      throw new Error('event body is required.');
    }
    return googleCalendarService.events.update(eventRef.calendarId, eventRef.eventId, third, fourth);
  },
  patch(first?: string | Record<string, unknown> | null, second?: string | Record<string, unknown>, third?: Record<string, unknown>, fourth?: Record<string, unknown>) {
    const eventRef = resolveCalendarEventAndOptions(first, second, undefined);
    if (!isRecord(third)) {
      throw new Error('patch body is required.');
    }
    return googleCalendarService.events.patch(eventRef.calendarId, eventRef.eventId, third, fourth);
  },
  delete(first?: string | Record<string, unknown> | null, second?: string | Record<string, unknown>, third?: Record<string, unknown>) {
    const resolved = resolveCalendarEventAndOptions(first, second, third);
    return googleCalendarService.events.delete(resolved.calendarId, resolved.eventId, resolved.options);
  },
  move(first?: string | null, second?: string, third?: string, fourth?: Record<string, unknown>) {
    const resolved = resolveCalendarEventMoveArgs(first, second, third, fourth);
    return googleCalendarService.events.move(
      resolved.calendarId,
      resolved.eventId,
      resolved.destinationCalendarId,
      resolved.options,
    );
  },
  instances(first?: string | Record<string, unknown> | null, second?: string | Record<string, unknown>, third?: Record<string, unknown>) {
    const resolved = resolveCalendarEventAndOptions(first, second, third);
    return googleCalendarService.events.instances(resolved.calendarId, resolved.eventId, resolved.options);
  },
  watch(first?: string | Record<string, unknown> | null, second?: Record<string, unknown>, third?: Record<string, unknown>) {
    const resolved = resolveWatchArgs(first, second, third);
    return googleCalendarService.events.watch(resolved.calendarId, resolved.channel, resolved.options);
  },
};

export const acl = {
  list(calendarIdOrOptions?: string | Record<string, unknown> | null, options?: Record<string, unknown>) {
    const resolved = resolveCalendarAndOptions(calendarIdOrOptions, options);
    return googleCalendarService.acl.list(resolved.calendarId, resolved.options);
  },
  get(first?: string | Record<string, unknown> | null, second?: string | Record<string, unknown>) {
    const resolved = resolveCalendarEventAndOptions(first, second);
    return googleCalendarService.acl.get(resolved.calendarId, resolved.eventId);
  },
  create(first?: string | Record<string, unknown> | null, second?: Record<string, unknown>, third?: Record<string, unknown>) {
    const resolved = resolveCalendarBodyAndOptions(first, second, third);
    return googleCalendarService.acl.create(resolved.calendarId, resolved.body, resolved.options);
  },
  insert(first?: string | Record<string, unknown> | null, second?: Record<string, unknown>, third?: Record<string, unknown>) {
    const resolved = resolveCalendarBodyAndOptions(first, second, third);
    return googleCalendarService.acl.insert(resolved.calendarId, resolved.body, resolved.options);
  },
  update(first?: string | Record<string, unknown> | null, second?: string | Record<string, unknown>, third?: Record<string, unknown>, fourth?: Record<string, unknown>) {
    const ruleRef = resolveCalendarEventAndOptions(first, second, undefined);
    if (!isRecord(third)) {
      throw new Error('rule body is required.');
    }
    return googleCalendarService.acl.update(ruleRef.calendarId, ruleRef.eventId, third, fourth);
  },
  patch(first?: string | Record<string, unknown> | null, second?: string | Record<string, unknown>, third?: Record<string, unknown>, fourth?: Record<string, unknown>) {
    const ruleRef = resolveCalendarEventAndOptions(first, second, undefined);
    if (!isRecord(third)) {
      throw new Error('rule body is required.');
    }
    return googleCalendarService.acl.patch(ruleRef.calendarId, ruleRef.eventId, third, fourth);
  },
  delete(first?: string | Record<string, unknown> | null, second?: string | Record<string, unknown>) {
    const resolved = resolveCalendarEventAndOptions(first, second);
    return googleCalendarService.acl.delete(resolved.calendarId, resolved.eventId);
  },
  watch(first?: string | Record<string, unknown> | null, second?: Record<string, unknown>, third?: Record<string, unknown>) {
    const resolved = resolveWatchArgs(first, second, third);
    return googleCalendarService.acl.watch(resolved.calendarId, resolved.channel, resolved.options);
  },
};

export const settings = {
  list: googleCalendarService.settings.list,
  get: googleCalendarService.settings.get,
  watch: googleCalendarService.settings.watch,
};

export const colors = {
  get: googleCalendarService.colors.get,
};

export const freeBusy = {
  query: googleCalendarService.freeBusy.query,
};

export const channels = {
  stop: googleCalendarService.channels.stop,
};

export const api = {
  request(method: string, path: string, options?: GoogleCalendarRequestOptions) {
    return googleCalendarService.request(method, path, options);
  },
};
