// lib/weather.js — Open-Meteo, no API key. Geocode once, cache, refresh weather hourly.
let geo = null;              // { lat, lon, label }
let cache = { data: null, exp: 0 };
let lastCity = null;         // caches are per-city: a /setup change busts them

const CODE = {
  0: ['Clear', '☀️'], 1: ['Mostly clear', '🌤️'], 2: ['Partly cloudy', '⛅'],
  3: ['Overcast', '☁️'], 45: ['Fog', '🌫️'], 48: ['Rime fog', '🌫️'],
  51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'],
  61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
  71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'],
  77: ['Snow grains', '🌨️'], 80: ['Showers', '🌦️'], 81: ['Showers', '🌧️'],
  82: ['Violent showers', '⛈️'], 85: ['Snow showers', '🌨️'], 86: ['Snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm', '⛈️'], 99: ['Thunderstorm', '⛈️'],
};

async function geocode(city) {
  if (geo) return geo;
  const u = new URL('https://geocoding-api.open-meteo.com/v1/search');
  u.searchParams.set('name', city);
  u.searchParams.set('count', '1');
  const r = await fetch(u);
  const j = await r.json();
  const hit = j.results?.[0];
  if (!hit) throw new Error(`weather: city "${city}" not found`);
  geo = { lat: hit.latitude, lon: hit.longitude, label: `${hit.name}${hit.admin1 ? ', ' + hit.admin1 : ''}` };
  return geo;
}

export async function getWeather(env, cityOverride) {
  const city = cityOverride || env.WEATHER_CITY || 'San Francisco';
  if (city !== lastCity) { geo = null; cache = { data: null, exp: 0 }; lastCity = city; }
  if (cache.data && Date.now() < cache.exp) return cache.data;
  try {
    const g = await geocode(city);
    const unit = (env.TEMP_UNIT || 'fahrenheit').toLowerCase();
    const u = new URL('https://api.open-meteo.com/v1/forecast');
    u.searchParams.set('latitude', g.lat);
    u.searchParams.set('longitude', g.lon);
    u.searchParams.set('current', 'temperature_2m,weather_code,apparent_temperature');
    u.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min');
    u.searchParams.set('temperature_unit', unit);
    u.searchParams.set('timezone', 'auto');
    const r = await fetch(u);
    const j = await r.json();
    const code = j.current?.weather_code ?? 0;
    const [label, icon] = CODE[code] || ['—', '🌡️'];
    const data = {
      city: g.label,
      temp: Math.round(j.current?.temperature_2m),
      feels: Math.round(j.current?.apparent_temperature),
      hi: Math.round(j.daily?.temperature_2m_max?.[0]),
      lo: Math.round(j.daily?.temperature_2m_min?.[0]),
      label, icon,
      unit: unit === 'celsius' ? 'C' : 'F',
    };
    cache = { data, exp: Date.now() + 30 * 60 * 1000 }; // 30 min
    return data;
  } catch (e) {
    return cache.data || { error: e.message };
  }
}
