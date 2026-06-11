import test from 'node:test';
import assert from 'node:assert/strict';
import { __internals } from '../tools/context/index.ts';

test('formats Serper response as compact snippets separated by blank lines', () => {
  const output = __internals.formatSerperSnippets({
    answerBox: {
      title: 'Krasnodar Weather',
      answer: '76°F',
    },
    organic: [
      { snippet: 'Current conditions are warm and cloudy.' },
      { snippet: 'Current conditions are warm and cloudy.' },
      { snippet: 'Rain is expected tonight.' },
    ],
    peopleAlsoAsk: [
      { snippet: 'January is usually the coldest month.' },
    ],
  }, 10);

  assert.equal(output, [
    'Krasnodar Weather: 76°F',
    'Current conditions are warm and cloudy.',
    'Rain is expected tonight.',
    'January is usually the coldest month.',
  ].join('\n\n'));
});

test('formats Open-Meteo current weather for LLM readability', () => {
  const output = __internals.formatWeather('Berlin', {
    name: 'Berlin',
    admin1: 'Berlin',
    country: 'Germany',
  }, {
    current: {
      time: '2026-06-03T12:00',
      temperature_2m: 21.5,
      apparent_temperature: 20.8,
      relative_humidity_2m: 54,
      precipitation: 0,
      weather_code: 2,
      wind_speed_10m: 12,
      wind_direction_10m: 90,
    },
    current_units: {
      temperature_2m: '°C',
      apparent_temperature: '°C',
      relative_humidity_2m: '%',
      precipitation: 'mm',
      wind_speed_10m: 'km/h',
    },
  });

  assert.match(output, /Weather for Berlin, Berlin, Germany/);
  assert.match(output, /Current: partly cloudy/);
  assert.match(output, /Temperature: 21.5°C; feels like 20.8°C/);
  assert.match(output, /Wind: 12km\/h from E/);
});

test('resolves weather date aliases and iso dates', () => {
  assert.deepEqual(__internals.resolveWeatherDate('today'), { mode: 'current', label: 'today' });
  assert.equal(__internals.resolveWeatherDate('tomorrow').mode, 'daily');
  assert.match(__internals.resolveWeatherDate('tomorrow').date || '', /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(__internals.resolveWeatherDate('2026-06-04'), {
    mode: 'daily',
    date: '2026-06-04',
    label: '2026-06-04',
  });
});

test('formats daily weather forecast as a compact summary', () => {
  const output = __internals.formatDailyWeather('Krasnodar', {
    name: 'Krasnodar',
    admin1: 'Krasnodar Krai',
    country: 'Russia',
  }, {
    daily: {
      time: ['2026-06-04'],
      weather_code: [2],
      temperature_2m_max: [24.1],
      temperature_2m_min: [17.3],
      apparent_temperature_max: [25.2],
      apparent_temperature_min: [16.8],
      precipitation_sum: [1.2],
      rain_sum: [1.2],
      showers_sum: [0],
      snowfall_sum: [0],
      wind_speed_10m_max: [14],
      wind_gusts_10m_max: [22],
      wind_direction_10m_dominant: [90],
      sunrise: ['2026-06-04T04:12'],
      sunset: ['2026-06-04T20:31'],
    },
    daily_units: {
      temperature_2m_max: '°C',
      temperature_2m_min: '°C',
      apparent_temperature_max: '°C',
      apparent_temperature_min: '°C',
      precipitation_sum: 'mm',
      rain_sum: 'mm',
      showers_sum: 'mm',
      snowfall_sum: 'cm',
      wind_speed_10m_max: 'km/h',
      wind_gusts_10m_max: 'km/h',
    },
  }, '2026-06-04', 'tomorrow');

  assert.match(output, /Forecast for tomorrow/);
  assert.match(output, /Condition: partly cloudy/);
  assert.match(output, /Temperature: high 24.1°C, low 17.3°C/);
  assert.match(output, /Wind: 14km\/h, gusts 22km\/h from E/);
});
