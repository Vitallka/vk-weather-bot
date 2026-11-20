/**
 * Бот «Погода на завтра» для группы ВКонтакте.
 *
 * Источник погоды — Open-Meteo (бесплатный, ключ не нужен).
 *
 * Режимы запуска:
 *   node index.js --test   показать текст поста в консоли (ничего не публикует)
 *   node index.js --now    опубликовать пост прямо сейчас
 *   node index.js          запустить по расписанию (CRON из .env, по умолчанию 08:00 каждый день)
 */

require('dotenv').config();
const cron = require('node-cron');

// ----------------------------- Конфигурация -----------------------------

const CITY = process.env.CITY || 'Москва';
const LAT = process.env.LAT;
const LON = process.env.LON;
const VK_GROUP_ID = (process.env.VK_GROUP_ID || '').replace(/[^\d-]/g, '');
const VK_TOKEN = process.env.VK_TOKEN || '';
const CRON_EXPR = process.env.CRON || '0 8 * * *';
const TZ_NAME = process.env.TZ_NAME || undefined;
const VK_API_VERSION = '5.199';

const MONTHS_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS_RU = ['воскресенье', 'понедельник', 'вторник', 'среда',
  'четверг', 'пятница', 'суббота'];

// ----------------------------- Погода -----------------------------

/** Находит город по названию и возвращает его координаты. */
async function geocode(city) {
  const url = 'https://geocoding-api.open-meteo.com/v1/search'
    + `?name=${encodeURIComponent(city)}&count=1&language=ru&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Сервис геокодирования недоступен (HTTP ${res.status})`);
  const json = await res.json();
  const place = json.results && json.results[0];
  if (!place) {
    throw new Error(`Город «${city}» не найден. Проверьте написание или задайте LAT/LON в .env`);
  }
  return { name: place.name, lat: place.latitude, lon: place.longitude };
}

/** Загружает прогноз на сегодня и завтра. */
async function fetchForecast(lat, lon) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    daily: [
      'weather_code',
      'temperature_2m_max',
      'temperature_2m_min',
      'precipitation_sum',
      'precipitation_probability_max',
      'wind_speed_10m_max',
      'sunrise',
      'sunset',
    ].join(','),
    timezone: 'auto',
    forecast_days: '2',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`Сервис погоды недоступен (HTTP ${res.status})`);
  const json = await res.json();
  if (!json.daily || !Array.isArray(json.daily.time)) {
    throw new Error('Неожиданный ответ сервиса погоды');
  }
  return json.daily;
}

/** Код погоды WMO -> [эмодзи, описание]. */
function describeWeather(code) {
  const map = {
    0: ['☀️', 'Ясно'],
    1: ['🌤', 'Преимущественно ясно'],
    2: ['⛅️', 'Переменная облачность'],
    3: ['☁️', 'Пасмурно'],
    45: ['🌫', 'Туман'],
    48: ['🌫', 'Изморозь и туман'],
    51: ['🌦', 'Слабая морось'],
    53: ['🌦', 'Морось'],
    55: ['🌧', 'Сильная морось'],
    56: ['🌧', 'Ледяная морось'],
    57: ['🌧', 'Сильная ледяная морось'],
    61: ['🌧', 'Слабый дождь'],
    63: ['🌧', 'Дождь'],
    65: ['🌧', 'Сильный дождь'],
    66: ['🌧', 'Ледяной дождь'],
    67: ['🌧', 'Сильный ледяной дождь'],
    71: ['🌨', 'Слабый снег'],
    73: ['🌨', 'Снег'],
    75: ['❄️', 'Сильный снег'],
    77: ['🌨', 'Снежные зёрна'],
    80: ['🌦', 'Слабый ливень'],
    81: ['🌧', 'Ливень'],
    82: ['⛈', 'Сильный ливень'],
    85: ['🌨', 'Снежный ливень'],
    86: ['❄️', 'Сильный снежный ливень'],
    95: ['⛈', 'Гроза'],
    96: ['⛈', 'Гроза с градом'],
    99: ['⛈', 'Сильная гроза с градом'],
  };
  return map[code] || ['🌡', 'Переменчивая погода'];
}

function fmtTemp(t) {
  const r = Math.round(t);
  return (r > 0 ? '+' : '') + r + '°';
}

/** Собирает текст поста про завтра. index — 1 (завтра) в массивах daily. */
function buildMessage(place, daily, i) {
  const date = new Date(`${daily.time[i]}T12:00:00`);
  const weekday = WEEKDAYS_RU[date.getDay()];
  const dayMonth = `${date.getDate()} ${MONTHS_RU[date.getMonth()]}`;
  const [icon, desc] = describeWeather(daily.weather_code[i]);

  const tMax = Math.round(daily.temperature_2m_max[i]);
  const tMin = Math.round(daily.temperature_2m_min[i]);
  const precip = (daily.precipitation_sum[i] ?? 0).toFixed(1).replace('.', ',');
  const prob = daily.precipitation_probability_max[i] ?? 0;
  const wind = Math.round(daily.wind_speed_10m_max[i]);
  const sunrise = (daily.sunrise[i] || '').slice(11, 16);
  const sunset = (daily.sunset[i] || '').slice(11, 16);

  const lines = [
    `${icon} Погода на завтра — ${place.name}, ${weekday}, ${dayMonth}`,
    '',
    `${desc}`,
    `🌡 Днём ${fmtTemp(tMax)}, ночью ${fmtTemp(tMin)}`,
    `🌧 Осадки: ${precip} мм (вероятность ${prob}%)`,
    `💨 Ветер: до ${wind} м/с`,
  ];
  if (sunrise && sunset) {
    lines.push(`🌅 Рассвет ${sunrise}, закат ${sunset}`);
  }

  // Небольшой совет по погоде
  const advice = [];
  if (prob >= 60 || Number(precip.replace(',', '.')) >= 2) advice.push('Возьмите зонт ☔');
  if (tMin <= -15) advice.push('Одевайтесь теплее, сильный мороз 🧣');
  if (tMax >= 28) advice.push('Жарко — пейте больше воды 💧');
  if (wind >= 15) advice.push('Будет сильный ветер 🌬');
  if (advice.length) lines.push('', advice.join('. ') + '.');

  lines.push('', '#погода #' + place.name.replace(/\s+/g, '_'));
  return lines.join('\n');
}

/** Возвращает готовый текст поста (геокодирует город, если нужно). */
async function getTomorrowMessage() {
  const place = (LAT && LON)
    ? { name: CITY, lat: LAT, lon: LON }
    : await geocode(CITY);
  const daily = await fetchForecast(place.lat, place.lon);
  if (daily.time.length < 2) {
    throw new Error('Прогноз на завтра пока недоступен, попробуйте позже');
  }
  return buildMessage(place, daily, 1);
}

// ----------------------------- ВКонтакте -----------------------------

/** Публикует сообщение на стене группы, возвращает id поста. */
async function postToVk(message) {
  if (!VK_GROUP_ID) throw new Error('Не задан VK_GROUP_ID (в bot/.env или в переменной окружения / Secrets)');
  if (!VK_TOKEN) throw new Error('Не задан VK_TOKEN (в bot/.env или в переменной окружения / Secrets)');

  const body = new URLSearchParams({
    owner_id: '-' + VK_GROUP_ID.replace(/^-/, ''),
    from_group: '1',
    message,
    v: VK_API_VERSION,
    access_token: VK_TOKEN,
  });

  const res = await fetch('https://api.vk.com/method/wall.post', { method: 'POST', body });
  const json = await res.json();
  if (json.error) {
    const { error_code, error_msg } = json.error;
    let hint = '';
    if (error_code === 5) hint = ' (проверьте VK_TOKEN — он неверный или истёк)';
    if (error_code === 15) hint = ' (у токена нет права «Работа со стеной» / wall)';
    if (error_code === 27) hint = ' (группа не разрешает публикацию с ключом сообщества)';
    throw new Error(`Ошибка VK API ${error_code}: ${error_msg}${hint}`);
  }
  return json.response.post_id;
}

async function publish() {
  const message = await getTomorrowMessage();
  const postId = await postToVk(message);
  console.log(`✅ Пост опубликован (id ${postId})`);
}

// ----------------------------- Запуск -----------------------------

async function main() {
  const mode = process.argv[2] || '';

  if (mode === '--test') {
    console.log(await getTomorrowMessage());
    return;
  }

  if (mode === '--now') {
    await publish();
    return;
  }

  // Режим расписания
  if (!cron.validate(CRON_EXPR)) {
    throw new Error(`Некорректное CRON-выражение в .env: "${CRON_EXPR}"`);
  }
  console.log(`🕒 Бот запущен. Город: ${CITY}. Расписание: ${CRON_EXPR}${TZ_NAME ? ' (' + TZ_NAME + ')' : ''}`);
  console.log('   Для проверки без публикации: npm test');
  console.log('   Для разовой публикации:      npm run post:now');
  cron.schedule(CRON_EXPR, () => {
    publish().catch((err) => console.error('❌', err.message));
  }, { timezone: TZ_NAME });
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
