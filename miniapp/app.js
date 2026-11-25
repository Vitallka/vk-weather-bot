/**
 * Мини-приложение «Погода на завтра» для ВКонтакте.
 * Работает через vk-bridge (внутри ВК) и как обычная страница в браузере.
 * Источник данных — Open-Meteo (бесплатный, ключ не нужен).
 */

// Инициализация моста VK (безопасно и вне ВКонтакте)
const bridge = window.vkBridge || null;
if (bridge) {
  try { bridge.send('VKWebAppInit'); } catch (e) { /* вне ВК */ }
}

const MONTHS_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS_RU = ['воскресенье', 'понедельник', 'вторник', 'среда',
  'четверг', 'пятница', 'суббота'];

function describeWeather(code) {
  const map = {
    0: ['☀️', 'Ясно'], 1: ['🌤', 'Преимущественно ясно'], 2: ['⛅️', 'Переменная облачность'],
    3: ['☁️', 'Пасмурно'], 45: ['🌫', 'Туман'], 48: ['🌫', 'Изморозь и туман'],
    51: ['🌦', 'Слабая морось'], 53: ['🌦', 'Морось'], 55: ['🌧', 'Сильная морось'],
    56: ['🌧', 'Ледяная морось'], 57: ['🌧', 'Сильная ледяная морось'],
    61: ['🌧', 'Слабый дождь'], 63: ['🌧', 'Дождь'], 65: ['🌧', 'Сильный дождь'],
    66: ['🌧', 'Ледяной дождь'], 67: ['🌧', 'Сильный ледяной дождь'],
    71: ['🌨', 'Слабый снег'], 73: ['🌨', 'Снег'], 75: ['❄️', 'Сильный снег'],
    77: ['🌨', 'Снежные зёрна'],
    80: ['🌦', 'Слабый ливень'], 81: ['🌧', 'Ливень'], 82: ['⛈', 'Сильный ливень'],
    85: ['🌨', 'Снежный ливень'], 86: ['❄️', 'Сильный снежный ливень'],
    95: ['⛈', 'Гроза'], 96: ['⛈', 'Гроза с градом'], 99: ['⛈', 'Сильная гроза с градом'],
  };
  return map[code] || ['🌡', 'Переменчивая погода'];
}

function fmtTemp(t) {
  const r = Math.round(t);
  return (r > 0 ? '+' : '') + r + '°';
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function geocode(city) {
  const url = 'https://geocoding-api.open-meteo.com/v1/search'
    + `?name=${encodeURIComponent(city)}&count=1&language=ru&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Сервис геокодирования недоступен');
  const json = await res.json();
  const place = json.results && json.results[0];
  if (!place) throw new Error(`Город «${city}» не найден`);
  return { name: place.name, lat: place.latitude, lon: place.longitude };
}

async function fetchWeather(lat, lon) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    daily: ['weather_code', 'temperature_2m_max', 'temperature_2m_min',
      'apparent_temperature_max', 'apparent_temperature_min',
      'precipitation_sum', 'precipitation_hours', 'precipitation_probability_max',
      'wind_speed_10m_max', 'wind_gusts_10m_max', 'snowfall_sum',
      'uv_index_max', 'sunrise', 'sunset'].join(','),
    hourly: ['temperature_2m', 'weather_code'].join(','),
    timezone: 'auto',
    forecast_days: '2',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error('Сервис погоды недоступен');
  const json = await res.json();
  if (!json.daily || json.daily.time.length < 2) throw new Error('Прогноз недоступен');
  return json;
}

function buildAdvice(daily, i) {
  const tMax = Math.round(daily.temperature_2m_max[i]);
  const tMin = Math.round(daily.temperature_2m_min[i]);
  const prob = daily.precipitation_probability_max[i] || 0;
  const precip = daily.precipitation_sum[i] || 0;
  const wind = Math.round(daily.wind_speed_10m_max[i]);
  const code = daily.weather_code[i];
  const uv = daily.uv_index_max ? (daily.uv_index_max[i] || 0) : 0;
  const feelsMin = daily.apparent_temperature_min ? Math.round(daily.apparent_temperature_min[i]) : tMin;
  const feelsMax = daily.apparent_temperature_max ? Math.round(daily.apparent_temperature_max[i]) : tMax;
  const snowCm = daily.snowfall_sum ? Math.round(daily.snowfall_sum[i] || 0) : 0;
  const gusts = daily.wind_gusts_10m_max ? Math.round(daily.wind_gusts_10m_max[i] || 0) : wind;
  const wetHours = daily.precipitation_hours ? Math.round(daily.precipitation_hours[i] || 0) : 0;
  const STORM = [95, 96, 99]; // грозы (коды WMO)
  const FOG = [45, 48];       // туман и изморозь (коды WMO)
  // Правила по убыванию важности, максимум три совета — как в боте
  const advice = [];
  if (STORM.includes(code)) advice.push('возможна гроза — лучше переждать в помещении ⛈');
  if (gusts >= 25) advice.push(`порывы ветра до ${gusts} м/с — по возможности останьтесь дома 🌀`);
  if (snowCm >= 5 && wind >= 15) advice.push('возможна метель — видимость плохая, возможны заносы 🌨');
  if (tMin > -5 && tMin <= 1 && (precip > 0 || prob >= 50)) advice.push('возможен гололёд — будьте осторожны 🧊');
  if (feelsMin <= -15) advice.push(`одевайтесь теплее: с ветром ощущается как ${feelsMin}° 🧣`);
  if (snowCm >= 2) advice.push(`ожидается снег, до ${snowCm} см 🌨`);
  if (gusts < 25 && wind >= 15) advice.push('будет сильный ветер 🌬');
  if (prob >= 60 || precip >= 2) {
    advice.push(wetHours >= 10 ? 'дождь почти весь день — без зонта никуда ☔' : 'возьмите зонт ☔');
  }
  if (FOG.includes(code)) advice.push('возможен туман — будьте внимательны на дорогах 🌫');
  if (feelsMax >= 28) advice.push('жарко — пейте больше воды 💧');
  if (feelsMax >= 33) advice.push('аномальная жара — берегитесь солнца 🥵');
  if (uv >= 7) advice.push('высокая активность солнца — нужен защитный крем 🧴');
  const top = advice.slice(0, 3);
  return top.length ? top.join(', ') : null;
}

function buildShareText(place, daily, i) {
  const date = new Date(`${daily.time[i]}T12:00:00`);
  const weekday = WEEKDAYS_RU[date.getDay()];
  const dayMonth = `${date.getDate()} ${MONTHS_RU[date.getMonth()]}`;
  const [icon, desc] = describeWeather(daily.weather_code[i]);
  const lines = [
    `${icon} Погода на завтра — ${place.name}, ${weekday}, ${dayMonth}`,
    '', desc,
    `🌡 Днём ${fmtTemp(daily.temperature_2m_max[i])}, ночью ${fmtTemp(daily.temperature_2m_min[i])}`,
    `🌧 Осадки: ${(daily.precipitation_sum[i] || 0).toFixed(1)} мм (вероятность ${daily.precipitation_probability_max[i] || 0}%)`,
    `💨 Ветер: до ${Math.round(daily.wind_speed_10m_max[i])} м/с`,
  ];
  const advice = buildAdvice(daily, i);
  if (advice) lines.push('', advice.charAt(0).toUpperCase() + advice.slice(1) + '.');
  lines.push('', '#погода');
  return lines.join('\n');
}

const state = { place: null, weather: null };

function render() {
  const { place, weather } = state;
  const daily = weather.daily;
  const tomorrowDate = daily.time[1];

  const d = new Date(`${tomorrowDate}T12:00:00`);
  const dateLabel = `${WEEKDAYS_RU[d.getDay()]}, ${d.getDate()} ${MONTHS_RU[d.getMonth()]}`;
  const [tmIcon, tmDesc] = describeWeather(daily.weather_code[1]);

  const precip = (daily.precipitation_sum[1] || 0).toFixed(1).replace('.', ',');
  const prob = daily.precipitation_probability_max[1] || 0;
  const wind = Math.round(daily.wind_speed_10m_max[1]);
  const sunrise = (daily.sunrise[1] || '').slice(11, 16);
  const sunset = (daily.sunset[1] || '').slice(11, 16);

  // Почасовые значения на завтра
  const hourly = weather.hourly || { time: [], temperature_2m: [], weather_code: [] };
  const hoursHtml = hourly.time
    .map((t, idx) => ({ t, temp: hourly.temperature_2m[idx], code: hourly.weather_code[idx] }))
    .filter((h) => h.t.startsWith(tomorrowDate))
    .map((h) => {
      const [icon] = describeWeather(h.code);
      return `<div class="hour">
        <div class="h-time">${esc(h.t.slice(11, 16))}</div>
        <div class="h-icon">${icon}</div>
        <div class="h-temp">${esc(fmtTemp(h.temp))}</div>
      </div>`;
    })
    .join('');

  const [tdIcon, tdDesc] = describeWeather(daily.weather_code[0]);

  const advice = buildAdvice(daily, 1);

  document.getElementById('content').innerHTML = `
    <div class="card">
      <div class="card-label">Завтра · ${esc(place.name)}</div>
      <div class="tomorrow-header">
        <div class="tomorrow-icon">${tmIcon}</div>
        <div class="tomorrow-temp">${esc(fmtTemp(daily.temperature_2m_max[1]))}
          <small>/ ${esc(fmtTemp(daily.temperature_2m_min[1]))}</small>
        </div>
      </div>
      <div class="tomorrow-desc">${esc(tmDesc)}</div>
      <div class="tomorrow-date">${esc(dateLabel)}</div>
      <div class="chips">
        <div class="chip"><div class="chip-title">Осадки</div>
          <div class="chip-value">🌧 ${esc(precip)} мм · ${esc(prob)}%</div></div>
        <div class="chip"><div class="chip-title">Ветер</div>
          <div class="chip-value">💨 до ${esc(wind)} м/с</div></div>
        <div class="chip"><div class="chip-title">Рассвет</div>
          <div class="chip-value">🌅 ${esc(sunrise || '—')}</div></div>
        <div class="chip"><div class="chip-title">Закат</div>
          <div class="chip-value">🌇 ${esc(sunset || '—')}</div></div>
      </div>
      ${advice ? `<div class="advice">${esc(advice.charAt(0).toUpperCase() + advice.slice(1))}.</div>` : ''}
    </div>

    <div class="card hourly" id="hourly">${hoursHtml || '<div class="loading">Нет почасовых данных</div>'}</div>

    <div class="card today-row">
      <div class="t-icon">${tdIcon}</div>
      <div class="t-text">Сегодня: ${esc(tdDesc.toLowerCase())},
        до ${esc(fmtTemp(daily.temperature_2m_max[0]))}</div>
    </div>
  `;

  document.getElementById('share-btn').hidden = false;
}

async function load(city) {
  const content = document.getElementById('content');
  const shareBtn = document.getElementById('share-btn');
  shareBtn.hidden = true;
  content.innerHTML = '<div class="loading">Загружаем прогноз…</div>';
  try {
    state.place = await geocode(city);
    state.weather = await fetchWeather(state.place.lat, state.place.lon);
    localStorage.setItem('vk_weather_city', city);
    document.getElementById('city-input').value = state.place.name;
    render();
  } catch (e) {
    content.innerHTML = `<div class="error">${esc(e.message)}</div>`;
  }
}

async function share() {
  if (!state.place || !state.weather) return;
  const text = buildShareText(state.place, state.weather.daily, 1);
  if (bridge) {
    try {
      await bridge.send('VKWebAppShowWallPostBox', { message: text });
      return;
    } catch (e) { /* пользователь закрыл окно или мы вне ВК */ }
  }
  // Запасной вариант вне ВКонтакте — копируем текст
  try {
    await navigator.clipboard.writeText(text);
    alert('Текст прогноза скопирован в буфер обмена');
  } catch (e) {
    alert(text);
  }
}

document.getElementById('city-btn').addEventListener('click', () => {
  const v = document.getElementById('city-input').value.trim();
  if (v) load(v);
});

document.getElementById('city-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const v = e.target.value.trim();
    if (v) load(v);
  }
});

document.getElementById('share-btn').addEventListener('click', share);

// Старт: сохранённый город или Москва
load(localStorage.getItem('vk_weather_city') || 'Москва');
