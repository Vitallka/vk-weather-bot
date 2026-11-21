/**
 * Боты «Погода на завтра» для групп ВКонтакте — поддерживает НЕСКОЛЬКО групп.
 *
 * Настройки берутся из .env (локально) или переменных окружения (GitHub Actions):
 *   Бот 1: VK_TOKEN,     VK_GROUP_ID,     CITY     (или LAT/LON)
 *   Бот 2: VK_TOKEN_2,   VK_GROUP_ID_2,   CITY_2   (или LAT_2/LON_2)
 *   Бот 3–5: аналогично с суффиксом _3, _4, _5
 *
 * Режимы запуска:
 *   node index.js --test       показать тексты постов всех ботов, ничего не публикуя
 *   node index.js --now        опубликовать посты во все группы прямо сейчас
 *   node index.js --scheduled  пост по расписанию GitHub: до POST_TIME (19:00 МСК)
 *                              ещё далеко (> 12 ч) — пропуск; иначе — отложенный пост
 *                              ровно на 19:00; после 19:00 — публикация сразу
 *   node index.js              по расписанию (CRON из .env; на GitHub время задаётся в workflow)
 */

require('dotenv').config();
const cron = require('node-cron');

// ----------------------------- Конфигурация -----------------------------

const CRON_EXPR = process.env.CRON || '0 8 * * *';
const TZ_NAME = process.env.TZ_NAME || undefined;
const VK_API_VERSION = '5.199';

// Время выхода поста в режиме --scheduled (по Москве, ЧЧ:ММ).
// GitHub Actions может запустить workflow с задержкой, поэтому:
//   до POST_TIME ещё > 12 часов — запуск пропускается: это ночная задержка
//                                 вчерашнего запуска, пост сделает плановый запуск дня;
//   до POST_TIME <= 12 часов     — создаётся отложенный пост (publish_date) ровно на POST_TIME;
//   POST_TIME уже прошло         — пост публикуется сразу (лучше позже, чем никак).
// ВАЖНО: время cron в .github/workflows/weather-post.yml должно попадать в окно
// отсрочки (сейчас cron в 14:15 МСК — до 19:00 остаётся 4 ч 45 мин).
const POST_TIME_MSK = process.env.POST_TIME || '19:00';
const DEFER_WINDOW_MS = 12 * 60 * 60 * 1000;

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
    throw new Error(`Город «${city}» не найден. Проверьте написание или задайте LAT/LON`);
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

/** Возвращает готовый текст поста для конкретного бота. */
async function buildPostForBot(bot) {
  const place = (bot.lat && bot.lon)
    ? { name: bot.city, lat: bot.lat, lon: bot.lon }
    : await geocode(bot.city);
  const daily = await fetchForecast(place.lat, place.lon);
  if (daily.time.length < 2) {
    throw new Error('Прогноз на завтра пока недоступен, попробуйте позже');
  }
  return buildMessage(place, daily, 1);
}

// ----------------------------- Отложенная публикация -----------------------------

/**
 * Решение для режима --scheduled: skip / defer / now (см. комментарий к POST_TIME_MSK).
 */
function computePublishPlan() {
  const match = POST_TIME_MSK.match(/^(\d{1,2}):(\d{2})$/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    console.warn(`⚠️ Некорректное POST_TIME «${POST_TIME_MSK}» — публикация без отсрочки`);
    return { action: 'now' };
  }
  const MSK_OFFSET_MS = 3 * 60 * 60 * 1000; // Москва = UTC+3, без перехода на летнее время
  const nowMs = Date.now();
  const mskNow = new Date(nowMs + MSK_OFFSET_MS);
  // Сегодняшние ЧЧ:ММ по Москве, переведённые в миллисекунды UTC
  const targetMs = Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth(),
    mskNow.getUTCDate(), Number(match[1]), Number(match[2]), 0) - MSK_OFFSET_MS;
  const msLeft = targetMs - nowMs;
  if (msLeft > DEFER_WINDOW_MS) return { action: 'skip' };
  if (msLeft <= 60 * 1000) return { action: 'now' };
  return { action: 'defer', unix: Math.floor(targetMs / 1000), label: POST_TIME_MSK };
}

// ----------------------------- ВКонтакте -----------------------------

/** Нормализует ID группы в формат owner_id (-123456). */
function groupOwnerId(groupId) {
  return '-' + String(groupId).replace(/[^\d]/g, '');
}

/** Публикует сообщение на стене группы, возвращает id поста.
 * publishDate — необязательное время (Unix): пост выйдет в ленту в этот момент. */
async function postToVk(message, groupId, token, publishDate) {
  if (!groupId) throw new Error('Не задан ID группы');
  if (!token) throw new Error('Не задан токен группы');

  const body = new URLSearchParams({
    owner_id: groupOwnerId(groupId),
    from_group: '1',
    message,
    v: VK_API_VERSION,
    access_token: token,
  });
  if (publishDate) body.set('publish_date', String(publishDate));

  const res = await fetch('https://api.vk.com/method/wall.post', { method: 'POST', body });
  const json = await res.json();
  if (json.error) {
    const { error_code, error_msg } = json.error;
    let hint = '';
    if (error_code === 5) hint = ' (проверьте токен — он неверный или истёк)';
    if (error_code === 15) hint = ' (у токена нет права «Работа со стеной» / wall)';
    if (error_code === 27) hint = ' (группа не разрешает публикацию с ключом сообщества)';
    throw new Error(`Ошибка VK API ${error_code}: ${error_msg}${hint}`);
  }
  return json.response.post_id;
}

// ----------------------------- Конфигурация ботов -----------------------------

/** Собирает список ботов из переменных окружения: бот 1 — без суффикса, бот 2-5 — с _2.._5. */
function collectBots() {
  const bots = [];
  for (let n = 1; n <= 5; n++) {
    const sfx = n === 1 ? '' : '_' + n;
    const token = process.env['VK_TOKEN' + sfx];
    const groupId = process.env['VK_GROUP_ID' + sfx];
    if (!token || !groupId) continue;
    bots.push({
      label: `Бот ${n}`,
      token,
      groupId,
      city: process.env['CITY' + sfx] || 'Москва',
      lat: process.env['LAT' + sfx],
      lon: process.env['LON' + sfx],
    });
  }
  return bots;
}

/** Прогоняет всех ботов. mode: 'test' — только показать,
 *  'now' — опубликовать сразу, 'scheduled' — отложить до POST_TIME_MSK. */
async function runAll(mode) {
  const bots = collectBots();
  if (!bots.length) {
    throw new Error('Не настроен ни один бот: нужны VK_TOKEN и VK_GROUP_ID (.env или Secrets)');
  }
  const plan = mode === 'scheduled' ? computePublishPlan() : { action: 'now' };
  if (plan.action === 'skip') {
    console.log(`⏭ До ${POST_TIME_MSK} МСК ещё далеко — этот запуск пропущен. ` +
      `Плановый вечерний запуск создаст пост точно к ${POST_TIME_MSK}.`);
    return;
  }
  const defer = plan.action === 'defer' ? plan : null;
  let hadError = false;
  for (const bot of bots) {
    try {
      const message = await buildPostForBot(bot);
      if (mode === 'test') {
        console.log(`——— ${bot.label}: ${bot.city} (группа ${bot.groupId}) ———`);
        console.log(message);
        console.log();
      } else {
        const postId = await postToVk(message, bot.groupId, bot.token, defer ? defer.unix : null);
        const when = defer
          ? `пост выйдет в ленту в ${defer.label} МСК (отложен, id ${postId})`
          : `пост опубликован (id ${postId})`;
        console.log(`✅ ${bot.label} (${bot.city}, группа ${bot.groupId}): ${when}`);
      }
    } catch (err) {
      hadError = true;
      console.error(`❌ ${bot.label} (${bot.city}, группа ${bot.groupId}): ${err.message}`);
    }
  }
  if (hadError) process.exitCode = 1;
}

// ----------------------------- Запуск -----------------------------

async function main() {
  const mode = process.argv[2] || '';

  if (mode === '--test') {
    return runAll('test');
  }

  if (mode === '--now') {
    return runAll('now');
  }

  if (mode === '--scheduled') {
    return runAll('scheduled');
  }

  // Режим расписания
  if (!cron.validate(CRON_EXPR)) {
    throw new Error(`Некорректное CRON-выражение: "${CRON_EXPR}"`);
  }
  const bots = collectBots();
  if (!bots.length) {
    throw new Error('Не настроен ни один бот: нужны VK_TOKEN и VK_GROUP_ID (.env или Secrets)');
  }
  const cities = bots.map((b) => b.city).join(', ');
  console.log(`🕒 Запущено ботов: ${bots.length} (${cities}). Расписание: ${CRON_EXPR}${TZ_NAME ? ' (' + TZ_NAME + ')' : ''}`);
  cron.schedule(CRON_EXPR, () => {
    runAll('now').catch((err) => console.error('❌', err.message));
  }, { timezone: TZ_NAME });
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
