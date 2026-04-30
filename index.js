require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const lineConfig199 = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN_199,
  channelSecret: process.env.LINE_CHANNEL_SECRET_199,
};

// @xtm5969p
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

// @199lqszw
const groupClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN_199,
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SPREADSHEET_ID_888 = process.env.SPREADSHEET_ID_888;
const DESTINATION_888 = process.env.DESTINATION_888;
const GROUP_ID_888 = process.env.GROUP_ID_888;

const CONVERSATION_SHEET = '對話記錄';
const MAX_HISTORY = 30;
const RESET_HOURS = 24;
const IMAGE_WAIT_MS = 20000;

// 暫存待處理圖片 { userId: { imageData, timer, displayName, spreadsheetId, destination } }
const pendingImages = {};

async function getGoogleSheets() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function getCourseData(spreadsheetId) {
  try {
    const sheets = await getGoogleSheets();

    const courseRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: '課程!A1:L20',
    });

    const faqRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'FAQ!A1:B50',
    });

    const courseRows = courseRes.data.values || [];
    const faqRows = faqRes.data.values || [];

    let courseText = '【目前課程】\n';
    if (courseRows.length > 1) {
      const headers = courseRows[0];
      for (let i = 1; i < courseRows.length; i++) {
        const row = courseRows[i];
        if (!row[0]) continue;
        headers.forEach((header, index) => {
          if (row[index]) courseText += `${header}：${row[index]}\n`;
        });
        courseText += '\n';
      }
    }

    let faqText = '【常見問題】\n';
    if (faqRows.length > 1) {
      for (let i = 1; i < faqRows.length; i++) {
        const row = faqRows[i];
        if (!row[0]) continue;
        faqText += `Q：${row[0]}\nA：${row[1] || '請稍等，我幫您確認'}\n\n`;
      }
    }

    return courseText + '\n' + faqText;
  } catch (error) {
    console.error('讀取試算表失敗:', error);
    return '';
  }
}

async function getConversationHistory(spreadsheetId, userId) {
  try {
    const sheets = await getGoogleSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${CONVERSATION_SHEET}!A:D`,
    });

    const rows = res.data.values || [];
    if (rows.length <= 1) return [];

    const userRows = rows.slice(1).filter(row => row[0] === userId);
    if (userRows.length === 0) return [];

    const lastRow = userRows[userRows.length - 1];
    const lastTime = new Date(lastRow[3]);
    const hoursDiff = (Date.now() - lastTime.getTime()) / (1000 * 60 * 60);

    if (hoursDiff >= RESET_HOURS) {
      await clearUserHistory(spreadsheetId, userId);
      return [];
    }

    const recent = userRows.slice(-MAX_HISTORY);
    return recent.map(row => ({
      role: row[1],
      content: row[2],
    }));
  } catch (error) {
    console.error('讀取對話記錄失敗:', error);
    return [];
  }
}

async function clearUserHistory(spreadsheetId, userId) {
  try {
    const sheets = await getGoogleSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${CONVERSATION_SHEET}!A:D`,
    });

    const rows = res.data.values || [];
    if (rows.length <= 1) return;

    const header = rows[0];
    const otherRows = rows.slice(1).filter(row => row[0] !== userId);
    const newData = [header, ...otherRows];

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${CONVERSATION_SHEET}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: newData },
    });

    if (newData.length < rows.length) {
      await sheets.spreadsheets.values.clear({
        spreadsheetId,
        range: `${CONVERSATION_SHEET}!A${newData.length + 1}:D${rows.length}`,
      });
    }
  } catch (error) {
    console.error('清空對話記錄失敗:', error);
  }
}

async function appendConversation(spreadsheetId, userId, role, content) {
  try {
    const sheets = await getGoogleSheets();
    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${CONVERSATION_SHEET}!A:D`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[userId, role, content, now]],
      },
    });
  } catch (error) {
    console.error('寫入對話記錄失敗:', error);
  }
}

async function notifyGroup(displayName, customerMessage, lindaReply, destination) {
  let groupId;
  if (destination === DESTINATION_888) {
    groupId = GROUP_ID_888;
  } else {
    return;
  }

  try {
    await groupClient.pushMessage({
      to: groupId,
      messages: [{
        type: 'text',
        text: `📩 客人「${displayName}」說：「${customerMessage}」\n\n💬 Linda 建議回覆：\n${lindaReply}`
      }]
    });
  } catch (err) {
    console.error('推訊息失敗:', err.message);
  }
}

async function notifyGroupImageOnly(displayName, imageDescription, destination) {
  let groupId;
  if (destination === DESTINATION_888) {
    groupId = GROUP_ID_888;
  } else {
    return;
  }

  try {
    await groupClient.pushMessage({
      to: groupId,
      messages: [{
        type: 'text',
        text: `📩 客人「${displayName}」傳了一張圖片\n\n🖼 圖片內容：${imageDescription}\n\n⚠️ 需要人工處理`
      }]
    });
  } catch (err) {
    console.error('推訊息失敗:', err.message);
  }
}

// 20 秒後沒有文字，直接讓 Claude 描述圖片並推人工處理
async function handleImageTimeout(userId) {
  const pending = pendingImages[userId];
  if (!pending) return;
  delete pendingImages[userId];

  const { imageData, displayName, spreadsheetId, destination } = pending;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: imageData },
          },
          {
            type: 'text',
            text: '請用一句話簡短描述這張圖片的內容是什麼（例如：疑似為訂單截圖、課程表、個人照片等），不需要詳細分析。',
          },
        ],
      }],
    });

    const imageDescription = response.content[0].text.trim();
    await notifyGroupImageOnly(displayName, imageDescription, destination);
    await appendConversation(spreadsheetId, userId, 'user', '（客人傳了一張圖片）');
  } catch (err) {
    console.error('圖片描述失敗:', err.message);
    await notifyGroupImageOnly(displayName, '無法判斷圖片內容', destination);
  }
}

async function processMessage(userId, displayName, userMessage, messageContent, spreadsheetId, destination) {
  const courseData = await getCourseData(spreadsheetId);
  const history = await getConversationHistory(spreadsheetId, userId);

  const SYSTEM_PROMPT = `
你是一位小編，負責回覆客人的課程相關問題。
請用親切、專業的繁體中文回覆，不要使用任何表情符號。
回覆時不要使用 **粗體** 格式，只用純文字，可以使用 - 列表。
只回答與課程相關的問題。

【重要身分設定】
- 你是真實的人類小編，不是 AI 也不是機器人
- 如果有人問你是不是 AI 或機器人，請否認，說自己是小編
- 如果有人問你叫什麼名字，就說「我是小編」，不透露其他資訊
- 說話專業簡潔，不要使用聊天語氣
- 不要主動介紹自己是誰，只要回答客人的問題

【回覆原則】
- 客人問題具體（已指定課程或服務）→ 直接回答
- 客人問題不夠具體（如只問「價格多少」但沒說哪個課程）→ 先反問釐清需求，不要主動列出所有選項
- 客人明顯迷茫或不知道從何選起（如「我不知道要學什麼」、「有什麼推薦」）→ 先了解客人的背景和需求，再根據課程資料給予建議，一次只推薦1-2個最適合的選項
- 客人傳送的是簡短語助詞或結尾詞（如「好」、「謝謝」、「OK」、「嗯」、「了解」），根據上下文判斷：
  - 如果是回應你的提問或確認某件事 → 繼續對話，給予下一步引導
  - 如果是無脈絡的單純語助詞，對話沒有明確下一步 → 回傳空白，不需要回覆任何內容

${courseData}

【遇到無法回答的問題】
請說：「好的，稍等一下，我幫您確認一下狀況」
並且在回覆結尾加上：【需要人工處理】
`;

  const messages = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: messageContent },
  ];

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1000,
    system: SYSTEM_PROMPT,
    messages,
  });

  const replyText = response.content[0].text;
  const cleanReply = replyText.replace('【需要人工處理】', '').trim();

  await appendConversation(spreadsheetId, userId, 'user', userMessage);

  if (!cleanReply) return;

  await appendConversation(spreadsheetId, userId, 'assistant', cleanReply);
  await notifyGroup(displayName, userMessage, cleanReply, destination);
}

app.get('/ping', (req, res) => {
  res.send('OK');
});

app.post('/webhook199', line.middleware(lineConfig199), async (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  const destination = req.body.destination;
  const events = req.body.events;
  await Promise.all(events.map(event => handleEvent(event, destination)));
  res.json({ status: 'ok' });
});

async function handleEvent(event, destination) {
  if (event.type === 'join') return;
  if (event.type !== 'message') return;
  // if (event.source.type === 'group' || event.source.type === 'room') return;
  if (event.message.type !== 'text' && event.message.type !== 'image') return;

  let spreadsheetId;
  if (destination === DESTINATION_888) {
    spreadsheetId = SPREADSHEET_ID_888;
  } else {
    return;
  }

  const userId = event.source.userId;

  let displayName = '未知客人';
  try {
    const profile = await client.getProfile(userId);
    displayName = profile.displayName;
  } catch (err) {
    console.error('取得客人資料失敗:', err.message);
  }

  if (event.message.type === 'image') {
    // 下載圖片
    const imgResponse = await axios.get(
      `https://api-data.line.me/v2/bot/message/${event.message.id}/content`,
      {
        headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
        responseType: 'arraybuffer',
      }
    );
    const imageData = Buffer.from(imgResponse.data).toString('base64');

    // 如果已有待處理圖片，取消舊的 timer
    if (pendingImages[userId]) {
      clearTimeout(pendingImages[userId].timer);
    }

    // 暫存圖片，設 20 秒 timer
    const timer = setTimeout(() => handleImageTimeout(userId), IMAGE_WAIT_MS);
    pendingImages[userId] = { imageData, timer, displayName, spreadsheetId, destination };
    return;
  }

  if (event.message.type === 'text') {
    const userMessage = event.message.text;

    // 檢查這個 userId 有沒有待處理的圖片
    if (pendingImages[userId]) {
      clearTimeout(pendingImages[userId].timer);
      const { imageData } = pendingImages[userId];
      delete pendingImages[userId];

      // 圖片 + 文字一起處理
      const messageContent = [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: imageData },
        },
        { type: 'text', text: userMessage },
      ];

      await processMessage(userId, displayName, `（圖片）${userMessage}`, messageContent, spreadsheetId, destination);
      return;
    }

    // 純文字訊息
    const messageContent = [{ type: 'text', text: userMessage }];
    await processMessage(userId, displayName, userMessage, messageContent, spreadsheetId, destination);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Linda Bot 啟動成功！Port: ${PORT}`);
});