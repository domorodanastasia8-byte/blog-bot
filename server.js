// ============================================================
//  Дневник блогера — сервер + бот
//  Всё в одном файле, чтобы было проще разобраться.
// ============================================================

const express = require('express');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const TOKEN = process.env.BOT_TOKEN;       // токен от @BotFather (задаётся в Secrets/Environment)
const APP_URL = process.env.APP_URL;       // публичный https-адрес сервера, без / в конце
const PORT = process.env.PORT || 3000;
const UPSTASH_URL = process.env.UPSTASH_URL;     // REST URL из консоли Upstash
const UPSTASH_TOKEN = process.env.UPSTASH_TOKEN; // REST TOKEN из консоли Upstash

if (!TOKEN) {
  console.error('⚠️  BOT_TOKEN не задан! Добавь его в переменные окружения.');
}
if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.error('⚠️  UPSTASH_URL / UPSTASH_TOKEN не заданы! Данные не будут сохраняться.');
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- постоянное хранилище (Upstash Redis, переживает перезапуски) ----------
async function upstashGet(key) {
  const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
  });
  const data = await res.json();
  return data.result; // строка или null, если ключа нет
}
async function upstashSet(key, value) {
  await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    body: value
  });
}
async function upstashDel(key) {
  await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
  });
}
function uid() {
  return 'id' + Date.now() + Math.floor(Math.random() * 10000);
}
async function addToList(key, item) {
  let arr = [];
  try {
    const raw = await upstashGet(key);
    arr = raw ? JSON.parse(raw) : [];
  } catch (e) { arr = []; }
  arr.push(item);
  await upstashSet(key, JSON.stringify(arr));
}
async function getList(key) {
  try {
    const raw = await upstashGet(key);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

// ---------- московское время (без внешних библиотек) ----------
function getMoscowParts() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Moscow', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short'
  });
  const map = {};
  fmt.formatToParts(new Date()).forEach(p => { map[p.type] = p.value; });
  return {
    dateStr: `${map.year}-${map.month}-${map.day}`,
    hour: parseInt(map.hour, 10),
    minute: parseInt(map.minute, 10),
    weekday: map.weekday // 'Sun', 'Mon', ...
  };
}
function getMoscowWeekRange() {
  const { dateStr } = getMoscowParts();
  const d = new Date(dateStr + 'T00:00:00');
  const offset = (d.getDay() + 6) % 7;
  const monday = new Date(d); monday.setDate(d.getDate() - offset);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  const toStr = dt => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  return { mondayStr: toStr(monday), sundayStr: toStr(sunday) };
}
const MONTH_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
function formatShort(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`;
}
const RUBRICS = [
  { key: 'dare', label: 'Тихая дерзость' },
  { key: 'dopamine', label: 'Дофаминовые радости' },
  { key: 'kitchen', label: 'Ночная кухня' },
  { key: 'shelf', label: 'Раскладываю по полочкам' }
];
const PLATFORMS = ['Telegram', 'Instagram', 'YouTube'];

// ---------- API для мини-приложения (повторяет window.storage) ----------
app.get('/api/storage/:key', async (req, res) => {
  try {
    const value = await upstashGet(req.params.key);
    if (value === null || value === undefined) return res.status(404).json({ error: 'not found' });
    res.json({ value });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/storage/:key', async (req, res) => {
  try {
    await upstashSet(req.params.key, req.body.value);
    res.json({ value: req.body.value });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/storage/:key', async (req, res) => {
  try {
    await upstashDel(req.params.key);
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- Telegram-бот (режим webhook — лучше дружит с бесплатным хостингом) ----------
const bot = new TelegramBot(TOKEN);

app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

function reply(chatId, text) {
  bot.sendMessage(chatId, text);
}

bot.onText(/^\/start/, async (msg) => {
  await upstashSet('bot-chat-id', String(msg.chat.id));
  bot.sendMessage(
    msg.chat.id,
    'Привет! Я твой помощник по блогу 🌸\n\n' +
      'Просто напиши сообщение, начиная с одного из слов:\n' +
      '• «Задачи ...» — добавлю в чек-лист\n' +
      '• «Идея ...» — добавлю в идеи\n' +
      '• «План ...» — добавлю в контент-план\n' +
      '• «Съемка ...» — добавлю в съёмочный план\n' +
      '• «Сводка» — пришлю сегодняшний план прямо сейчас\n' +
      '• «Итоги» — пришлю сводку за неделю прямо сейчас\n\n' +
      'Например: Задачи оформить инстаграм\n\n' +
      'Каждое утро в 10:00 по Москве буду присылать сводку на день, а по воскресеньям в 20:00 — итоги недели (как в дашборде мини-приложения).',
    {
      reply_markup: {
        inline_keyboard: [[{ text: '📋 Открыть приложение', web_app: { url: APP_URL } }]]
      }
    }
  );
});

bot.on('message', async (msg) => {
  // запоминаем chat_id при любом сообщении, чтобы знать, куда слать утреннюю сводку
  upstashSet('bot-chat-id', String(msg.chat.id)).catch(() => {});

  if (!msg.text || msg.text.startsWith('/start')) return;
  const text = msg.text.trim();
  const norm = text.toLowerCase().replace(/ё/g, 'е');

  if (/^сводк[а-я]*$/.test(norm)) {
    await sendDailyDigest(msg.chat.id);
    return;
  }
  if (/^итог[а-я]*$/.test(norm)) {
    await sendWeeklyDigest(msg.chat.id);
    return;
  }

  let matched = null;
  let rest = text;

  if (/^задач[аи]/.test(norm)) { matched = 'tasks'; rest = text.replace(/^задач[аи]/i, ''); }
  else if (/^иде[яи]/.test(norm)) { matched = 'ideas'; rest = text.replace(/^иде[яи]/i, ''); }
  else if (/^контент[\s-]?план/.test(norm)) { matched = 'plan'; rest = text.replace(/^контент[\s-]?план/i, ''); }
  else if (/^план/.test(norm)) { matched = 'plan'; rest = text.replace(/^план/i, ''); }
  else if (/^съемочны[йя][\s-]?план/.test(norm)) { matched = 'shoot'; rest = text.replace(/^съемочны[йя][\s-]?план/i, ''); }
  else if (/^съемк[аи]/.test(norm)) { matched = 'shoot'; rest = text.replace(/^съемк[аи]/i, ''); }

  if (!matched) {
    reply(msg.chat.id, 'Не поняла 🙈 Начни сообщение со слова: Задачи / Идея / План / Съемка');
    return;
  }

  rest = rest.replace(/^[\s:\-—]+/, '').trim();
  if (!rest) {
    reply(msg.chat.id, 'А текст? Например: «Задачи купить лампу»');
    return;
  }

  try {
    if (matched === 'tasks') {
      await addToList('checklist-items', { id: uid(), text: rest, done: false, date: '', priority: 'Средний', starred: false });
      reply(msg.chat.id, `✅ Добавила в чек-лист: «${rest}»`);
    } else if (matched === 'ideas') {
      await addToList('ideas', { id: uid(), text: rest, rubric: '' });
      reply(msg.chat.id, `💡 Добавила в идеи: «${rest}»`);
    } else if (matched === 'plan') {
      await addToList('content-items', {
        id: uid(), topic: rest, rubric: '', platforms: [], date: '', shootDate: '',
        script: '', shootList: [], filmed: false, edited: false, published: false
      });
      reply(msg.chat.id, `🗓 Добавила в контент-план: «${rest}»`);
    } else if (matched === 'shoot') {
      const today = getMoscowParts().dateStr;
      await addToList('content-items', {
        id: uid(), topic: rest, rubric: '', platforms: [], date: '', shootDate: today,
        script: '', shootList: [{ id: uid(), type: 'Видео', desc: rest, done: false }],
        filmed: false, edited: false, published: false
      });
      reply(msg.chat.id, `🎥 Добавила в съёмочный план: «${rest}»`);
    }
  } catch (e) {
    console.error('Ошибка сохранения:', e.message);
    reply(msg.chat.id, 'Упс, не получилось сохранить — попробуй ещё раз через минутку 🙏');
  }
});

// ---------- ежедневная сводка в 10:00 по Москве ----------
async function sendDailyDigest(overrideChatId) {
  const chatId = overrideChatId || await upstashGet('bot-chat-id');
  if (!chatId) { console.log('Нет chat_id — некому слать сводку.'); return; }

  const todayStr = getMoscowParts().dateStr;
  const checklist = await getList('checklist-items');
  const contentItems = await getList('content-items');

  const todayTasks = checklist.filter(t => !t.done && t.date === todayStr);
  const overdueTasks = checklist.filter(t => !t.done && t.date && t.date < todayStr);

  const todayShoot = contentItems.filter(it => !it.noPost && !it.filmed && it.shootDate === todayStr);
  const overdueShoot = contentItems.filter(it => !it.noPost && !it.filmed && it.shootDate && it.shootDate < todayStr);

  const todayPublish = contentItems.filter(it => !it.noPost && !it.published && it.date === todayStr);
  const overduePublish = contentItems.filter(it => !it.noPost && !it.published && it.date && it.date < todayStr);

  const hasAnything = todayTasks.length || overdueTasks.length || todayShoot.length || overdueShoot.length || todayPublish.length || overduePublish.length;

  if (!hasAnything) {
    bot.sendMessage(chatId, '☀️ Доброе утро! На сегодня ничего не запланировано и долгов нет — можно выдохнуть 🌿');
    return;
  }

  let text = '☀️ Доброе утро! Вот план на сегодня:\n';

  if (overdueTasks.length || overdueShoot.length || overduePublish.length) {
    text += '\n⚠️ Просрочено:\n';
    if (overdueTasks.length) text += overdueTasks.map(t => `• Задача: ${t.text} (была на ${t.date})`).join('\n') + '\n';
    if (overdueShoot.length) text += overdueShoot.map(it => `• Снять: ${it.topic} (было на ${it.shootDate})`).join('\n') + '\n';
    if (overduePublish.length) text += overduePublish.map(it => `• Опубликовать: ${it.topic} (было на ${it.date})`).join('\n') + '\n';
  }

  if (todayTasks.length) {
    text += '\n📋 Задачи на сегодня:\n' + todayTasks.map(t => `• ${t.text}`).join('\n') + '\n';
  }
  if (todayShoot.length) {
    text += '\n🎥 Снять сегодня:\n' + todayShoot.map(it => `• ${it.topic}`).join('\n') + '\n';
  }
  if (todayPublish.length) {
    text += '\n🚀 Опубликовать сегодня:\n' + todayPublish.map(it => `• ${it.topic}`).join('\n') + '\n';
  }

  bot.sendMessage(chatId, text.trim());
}

// ---------- недельная сводка по воскресеньям в 20:00 по Москве ----------
async function sendWeeklyDigest(overrideChatId) {
  const chatId = overrideChatId || await upstashGet('bot-chat-id');
  if (!chatId) { console.log('Нет chat_id — некому слать сводку недели.'); return; }

  const { mondayStr, sundayStr } = getMoscowWeekRange();
  const inWeek = d => !!d && d >= mondayStr && d <= sundayStr;

  const checklist = await getList('checklist-items');
  const contentItems = await getList('content-items');
  const ideas = await getList('ideas');
  const analyticsEntries = await getList('analytics-entries');
  const postAnalytics = await getList('post-analytics');
  const promotions = await getList('promotions');

  const planItems = contentItems.filter(it => !it.noPost);
  const periodPublished = planItems.filter(it => it.published && inWeek(it.publishedAt || it.date));
  const periodDoneTasks = checklist.filter(t => t.done && inWeek(t.completedAt || t.date));
  const periodRealizedIdeas = ideas.filter(i => i.realized && inWeek(i.realizedAt));

  const platformLatest = {};
  PLATFORMS.forEach(p => {
    const entries = analyticsEntries.filter(e => e.platform === p).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const weekEntries = entries.filter(e => inWeek(e.date));
    if (weekEntries.length) {
      const latest = weekEntries[weekEntries.length - 1];
      const idx = entries.indexOf(latest);
      const prev = idx > 0 ? entries[idx - 1] : null;
      const delta = (prev && latest.followers != null && prev.followers != null) ? latest.followers - prev.followers : null;
      platformLatest[p] = { followers: latest.followers, delta };
    }
  });

  const weekPosts = postAnalytics.filter(p => inWeek(p.date));
  const topPosts = weekPosts.slice().sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 3);

  const periodRubricItems = planItems.filter(it => inWeek(it.publishedAt || it.date));
  const rubricCounts = {}; RUBRICS.forEach(r => rubricCounts[r.key] = 0);
  periodRubricItems.forEach(it => { if (it.rubric && rubricCounts[it.rubric] !== undefined) rubricCounts[it.rubric]++; });
  const rubricTotal = periodRubricItems.length || 1;

  const weekPromos = promotions.filter(p => inWeek(p.date));
  const promoCost = weekPromos.reduce((s, p) => s + (p.cost || 0), 0);
  const promoSubs = weekPromos.reduce((s, p) => s + (p.subscribers || 0), 0);

  let text = `📊 Итоги недели: ${formatShort(mondayStr)} – ${formatShort(sundayStr)}\n\n`;
  text += 'Общая сводка:\n';
  text += `• Опубликовано постов: ${periodPublished.length}\n`;
  text += `• Задач закрыто: ${periodDoneTasks.length}\n`;
  text += `• Идей реализовано: ${periodRealizedIdeas.length}\n`;

  const platLines = PLATFORMS.filter(p => platformLatest[p]).map(p => {
    const e = platformLatest[p];
    const d = e.delta != null ? ` (${e.delta >= 0 ? '+' : ''}${e.delta})` : '';
    return `• ${p}: ${e.followers ?? '—'} подписчиков${d}`;
  });
  if (platLines.length) text += '\nАналитика по площадкам:\n' + platLines.join('\n') + '\n';

  if (topPosts.length) {
    text += '\nЛучшие публикации:\n' + topPosts.map((p, i) => `${i + 1}. «${p.topic || 'без темы'}» — ${p.views ?? 0} просмотров (${p.platform || '—'})`).join('\n') + '\n';
  }

  const rubLines = RUBRICS.filter(r => rubricCounts[r.key] > 0).map(r => `• ${r.label}: ${Math.round(rubricCounts[r.key] / rubricTotal * 100)}%`);
  if (rubLines.length) text += '\nБаланс рубрик:\n' + rubLines.join('\n') + '\n';

  if (weekPromos.length) {
    text += `\nПродвижение:\n• Потрачено: ${promoCost}\n• Новых подписчиков: ${promoSubs}\n`;
  }

  text += '\nХорошей новой недели! 🌸';

  bot.sendMessage(chatId, text.trim());
}

setInterval(async () => {
  try {
    const { dateStr, hour, minute, weekday } = getMoscowParts();
    if (hour === 10 && minute === 0) {
      const lastSent = await upstashGet('last-digest-date');
      if (lastSent !== dateStr) {
        await sendDailyDigest();
        await upstashSet('last-digest-date', dateStr);
      }
    }
    if (weekday === 'Sun' && hour === 20 && minute === 0) {
      const lastWeekly = await upstashGet('last-weekly-digest-date');
      if (lastWeekly !== dateStr) {
        await sendWeeklyDigest();
        await upstashSet('last-weekly-digest-date', dateStr);
      }
    }
  } catch (e) {
    console.error('Ошибка проверки расписания:', e.message);
  }
}, 20 * 1000);

app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
  if (TOKEN && APP_URL) {
    bot.setWebHook(`${APP_URL}/bot${TOKEN}`)
      .then(() => console.log('✅ Webhook установлен на ' + APP_URL))
      .catch(e => console.error('Ошибка установки webhook:', e.message));
  } else {
    console.log('⏳ APP_URL или BOT_TOKEN ещё не заданы — webhook не установлен.');
  }
});
