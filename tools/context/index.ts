type WebOptions = {
  maxResults?: number;
  timeoutMs?: number;
  freshness?: string;
};

type WeatherOptions = {
  temperatureUnit?: 'celsius' | 'fahrenheit';
  windSpeedUnit?: 'kmh' | 'ms' | 'mph' | 'kn';
  timeoutMs?: number;
  date?: 'today' | 'tomorrow' | string;
};

type CacheEntry = {
  expiresAt: number;
  value: string;
};

const SERPER_API_KEY = process.env.SERPER_API_KEY || '26fe6fc7e08b5220c096e92d847f1cd4f3ccb94a';
const SERPER_SEARCH_URL = 'https://google.serper.dev/search';
const OPEN_METEO_GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const DEFAULT_WEB_TIMEOUT_MS = 2500;
const DEFAULT_WEATHER_TIMEOUT_MS = 2500;
const CACHE_TTL_MS = 2 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

function getCached(key: string): string | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(key: string, value: string): void {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function cleanText(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = cleanText(value);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
  }
  return result;
}

function formatSerperSnippets(data: any, maxResults: number): string {
  const snippets: string[] = [];

  if (data?.answerBox?.answer) {
    const title = cleanText(data.answerBox.title);
    const answer = cleanText(data.answerBox.answer);
    snippets.push(title ? `${title}: ${answer}` : answer);
  }

  if (data?.answerBox?.snippet) {
    snippets.push(data.answerBox.snippet);
  }

  for (const item of Array.isArray(data?.organic) ? data.organic : []) {
    snippets.push(item?.snippet);
  }

  for (const item of Array.isArray(data?.peopleAlsoAsk) ? data.peopleAlsoAsk : []) {
    snippets.push(item?.snippet);
  }

  const compact = uniqueNonEmpty(snippets).slice(0, maxResults);
  return compact.length > 0 ? compact.join('\n\n') : 'No fast context snippets found.';
}

export async function web(query: string, options: WebOptions = {}): Promise<string> {
  const q = cleanText(query);
  if (!q) {
    throw new Error('context.web(query): query must be a non-empty string');
  }

  const maxResults = clampInt(options.maxResults, 8, 1, 20);
  const timeoutMs = clampInt(options.timeoutMs, DEFAULT_WEB_TIMEOUT_MS, 250, 10000);
  const freshness = cleanText(options.freshness);
  const cacheKey = `web:${q}:${maxResults}:${freshness}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const payload: Record<string, unknown> = { q, num: maxResults };
  if (freshness) {
    payload.tbs = freshness;
  }

  const data = await fetchJson(SERPER_SEARCH_URL, {
    method: 'POST',
    headers: {
      'X-API-KEY': SERPER_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  }, timeoutMs);

  const result = formatSerperSnippets(data, maxResults);
  setCached(cacheKey, result);
  return result;
}

function weatherCodeLabel(code: unknown): string {
  switch (Number(code)) {
    case 0: return 'clear sky';
    case 1: return 'mainly clear';
    case 2: return 'partly cloudy';
    case 3: return 'overcast';
    case 45:
    case 48: return 'fog';
    case 51:
    case 53:
    case 55: return 'drizzle';
    case 56:
    case 57: return 'freezing drizzle';
    case 61:
    case 63:
    case 65: return 'rain';
    case 66:
    case 67: return 'freezing rain';
    case 71:
    case 73:
    case 75: return 'snow';
    case 77: return 'snow grains';
    case 80:
    case 81:
    case 82: return 'rain showers';
    case 85:
    case 86: return 'snow showers';
    case 95: return 'thunderstorm';
    case 96:
    case 99: return 'thunderstorm with hail';
    default: return `weather code ${cleanText(code) || 'unknown'}`;
  }
}

function windDirectionLabel(degrees: unknown): string {
  const value = Number(degrees);
  if (!Number.isFinite(value)) return '';
  const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return labels[Math.round(value / 45) % 8] || '';
}

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function resolveWeatherDate(dateValue: unknown): { mode: 'current' | 'daily'; date?: string; label?: string } {
  const raw = cleanText(dateValue);
  if (!raw || raw === 'today') {
    return { mode: 'current', label: 'today' };
  }
  if (raw === 'tomorrow') {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + 1);
    return { mode: 'daily', date: toIsoDate(date), label: 'tomorrow' };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { mode: 'daily', date: raw, label: raw };
  }
  return { mode: 'daily', date: raw, label: raw };
}

function formatWeather(locationQuery: string, place: any, forecast: any): string {
  const current = forecast?.current || {};
  const units = forecast?.current_units || {};
  const resolvedName = [
    place?.name,
    place?.admin1,
    place?.country,
  ].map(cleanText).filter(Boolean).join(', ') || locationQuery;

  const temp = current.temperature_2m;
  const apparent = current.apparent_temperature;
  const humidity = current.relative_humidity_2m;
  const precipitation = current.precipitation;
  const windSpeed = current.wind_speed_10m;
  const windDirection = current.wind_direction_10m;
  const windLabel = windDirectionLabel(windDirection);
  const condition = weatherCodeLabel(current.weather_code);
  const observedAt = cleanText(current.time);

  return [
    `Weather for ${resolvedName}`,
    `Current: ${condition}`,
    `Temperature: ${temp}${units.temperature_2m || ''}; feels like ${apparent}${units.apparent_temperature || ''}`,
    `Humidity: ${humidity}${units.relative_humidity_2m || ''}`,
    `Precipitation: ${precipitation}${units.precipitation || ''}`,
    `Wind: ${windSpeed}${units.wind_speed_10m || ''}${windLabel ? ` from ${windLabel}` : ''}`,
    observedAt ? `Observed: ${observedAt}` : '',
  ].filter(Boolean).join('\n');
}

function formatDailyWeather(locationQuery: string, place: any, forecast: any, requestedDate: string, label?: string): string {
  const daily = forecast?.daily || {};
  const units = forecast?.daily_units || {};
  const resolvedName = [
    place?.name,
    place?.admin1,
    place?.country,
  ].map(cleanText).filter(Boolean).join(', ') || locationQuery;

  const dates = Array.isArray(daily.time) ? daily.time : [];
  const index = dates.indexOf(requestedDate);
  if (index < 0) {
    return `No forecast found for ${label || requestedDate} in ${resolvedName}.`;
  }

  const at = (key: string): any => Array.isArray((daily as any)[key]) ? (daily as any)[key][index] : undefined;
  const minTemp = at('temperature_2m_min');
  const maxTemp = at('temperature_2m_max');
  const apparentMin = at('apparent_temperature_min');
  const apparentMax = at('apparent_temperature_max');
  const precipitation = at('precipitation_sum');
  const rain = at('rain_sum');
  const showers = at('showers_sum');
  const snowfall = at('snowfall_sum');
  const windSpeed = at('wind_speed_10m_max');
  const windGusts = at('wind_gusts_10m_max');
  const windDirection = at('wind_direction_10m_dominant');
  const sunrise = cleanText(at('sunrise'));
  const sunset = cleanText(at('sunset'));
  const condition = weatherCodeLabel(at('weather_code'));
  const windLabel = windDirectionLabel(windDirection);

  return [
    `Weather for ${resolvedName}`,
    `Forecast for ${label || requestedDate}`,
    `Condition: ${condition}`,
    `Temperature: high ${maxTemp}${units.temperature_2m_max || ''}, low ${minTemp}${units.temperature_2m_min || ''}`,
    `Feels like: high ${apparentMax}${units.apparent_temperature_max || ''}, low ${apparentMin}${units.apparent_temperature_min || ''}`,
    `Precipitation: ${precipitation}${units.precipitation_sum || ''}${rain !== undefined ? ` rain ${rain}${units.rain_sum || ''}` : ''}${showers !== undefined ? ` showers ${showers}${units.showers_sum || ''}` : ''}${snowfall !== undefined ? ` snow ${snowfall}${units.snowfall_sum || ''}` : ''}`,
    `Wind: ${windSpeed}${units.wind_speed_10m_max || ''}${windGusts !== undefined ? `, gusts ${windGusts}${units.wind_gusts_10m_max || ''}` : ''}${windLabel ? ` from ${windLabel}` : ''}`,
    sunrise || sunset ? `Sunrise/sunset: ${sunrise || '?'} / ${sunset || '?'}` : '',
  ].filter(Boolean).join('\n');
}

export async function weather(location: string, options: WeatherOptions = {}): Promise<string> {
  const query = cleanText(location);
  if (!query) {
    throw new Error('context.weather(location): location must be a non-empty string');
  }

  const timeoutMs = clampInt(options.timeoutMs, DEFAULT_WEATHER_TIMEOUT_MS, 250, 10000);
  const temperatureUnit = options.temperatureUnit === 'fahrenheit' ? 'fahrenheit' : 'celsius';
  const windSpeedUnit = ['kmh', 'ms', 'mph', 'kn'].includes(String(options.windSpeedUnit))
    ? options.windSpeedUnit
    : 'kmh';
  const requestedDate = resolveWeatherDate(options.date);
  const cacheKey = `weather:${query}:${temperatureUnit}:${windSpeedUnit}:${requestedDate.mode}:${requestedDate.date || ''}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const geoUrl = new URL(OPEN_METEO_GEOCODE_URL);
  geoUrl.searchParams.set('name', query);
  geoUrl.searchParams.set('count', '1');
  geoUrl.searchParams.set('language', 'en');
  geoUrl.searchParams.set('format', 'json');

  const geo = await fetchJson(geoUrl.toString(), { method: 'GET' }, timeoutMs);
  const place = Array.isArray(geo?.results) ? geo.results[0] : null;
  if (!place || typeof place.latitude !== 'number' || typeof place.longitude !== 'number') {
    return `No weather location found for "${query}".`;
  }

  const forecastUrl = new URL(OPEN_METEO_FORECAST_URL);
  forecastUrl.searchParams.set('latitude', String(place.latitude));
  forecastUrl.searchParams.set('longitude', String(place.longitude));
  forecastUrl.searchParams.set('timezone', 'auto');
  forecastUrl.searchParams.set('temperature_unit', temperatureUnit);
  forecastUrl.searchParams.set('wind_speed_unit', windSpeedUnit);

  if (requestedDate.mode === 'daily' && requestedDate.date) {
    forecastUrl.searchParams.set('daily', [
      'weather_code',
      'temperature_2m_max',
      'temperature_2m_min',
      'apparent_temperature_max',
      'apparent_temperature_min',
      'precipitation_sum',
      'rain_sum',
      'showers_sum',
      'snowfall_sum',
      'wind_speed_10m_max',
      'wind_gusts_10m_max',
      'wind_direction_10m_dominant',
      'sunrise',
      'sunset',
    ].join(','));
    forecastUrl.searchParams.set('start_date', requestedDate.date);
    forecastUrl.searchParams.set('end_date', requestedDate.date);
  } else {
    forecastUrl.searchParams.set('current', [
      'temperature_2m',
      'apparent_temperature',
      'relative_humidity_2m',
      'precipitation',
      'weather_code',
      'wind_speed_10m',
      'wind_direction_10m',
    ].join(','));
  }

  const forecast = await fetchJson(forecastUrl.toString(), { method: 'GET' }, timeoutMs);
  const result = requestedDate.mode === 'daily' && requestedDate.date
    ? formatDailyWeather(query, place, forecast, requestedDate.date, requestedDate.label)
    : formatWeather(query, place, forecast);
  setCached(cacheKey, result);
  return result;
}

export const __internals = {
  formatSerperSnippets,
  formatWeather,
  formatDailyWeather,
  weatherCodeLabel,
  windDirectionLabel,
  resolveWeatherDate,
  uniqueNonEmpty,
};
