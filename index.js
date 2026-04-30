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

// @xtm5969p：收客人訊息用
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

// @199lqszw：推訊息到群組用
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

// 取得某個 userId 的對話歷史
async function getConversationHistory(spreadsheetId, userId) {
  try {
    const sheets = await getGoogleSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${CONVERSATION_SHEET}!A:D`,
    });

    const rows = res.data.values || [];
    if (rows.length <= 1) return [];

    // 過濾出這個 userId 的對話
    const userRows = rows.slice(1).filter(row => row[0] === userId);
    if (userRows.length === 0) return [];

    // 檢查最後一則訊息的時間，超過24小時就清空
    const lastRow = userRows[userRows.length - 1];
    const lastTime = new Date(lastRow[3]);
    const hoursDiff = (Date.now() - lastTime.getTime()) / (1000 * 60 * 60);

    if (hoursDiff >= RESET_HOURS) {
      // 超過24小時，清空這個 userId 的記錄
      await clearUserHistory(spreadsheetId, userId);
      return [];
    }

    // 只取最近 MAX_HISTORY 則
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

// 清空某個 userId 的對話記錄
async function clearUserHistory(spreadsheetId, userId) {
  try {
    const sheets = await getGoogleSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${CONVERSATION_SHEET}!A:D`,
    });

    const rows = res.data.values || [];
    if (rows.length <= 1) return;

    // 保留標題列和其他 userId 的資料
    const header = rows[0];
    const otherRows = rows.slice(1).filter(row => row[0] !== userId);
    const newData = [header, ...otherRows];

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${CONVERSATION_SHEET}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: newData },
    });

    // 清空多餘的列
    if (newData.length < rows.length) {
      const clearStart = newData.length + 1;
      const clearEnd = rows.length;
      await sheets.spreadsheets.values.clear({
        spreadsheetId,
        range: `${CONVERSATION_SHEET}!A${clearStart}:D${clearEnd}`,
      });
    }
  } catch (error) {
    console.error('清空對話記錄失敗:', error);
  }
}

// 新增對話記錄
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

async function notifyGroup(customerMessage, lindaReply, destination) {
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
        text: `📩 客人說：「${customerMessage}」\n\n💬 Linda 建議回覆：\n${lindaReply}`
      }]
    });
  } catch (err) {
    console.error('推訊息失敗:', err.message);
  }
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
  const courseData = await getCourseData(spreadsheetId);

  // 取得對話歷史
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

${courseData}

【遇到無法回答的問題】
請說：「好的，稍等一下，我幫您確認一下狀況」
並且在回覆結尾加上：【需要人工處理】
`;

  let userMessage = '';
  let messageContent;

  if (event.message.type === 'text') {
    userMessage = event.message.text;
    messageContent = [{ type: 'text', text: userMessage }];
  } else if (event.message.type === 'image') {
    const imgResponse = await axios.get(
      `https://api-data.line.me/v2/bot/message/${event.message.id}/content`,
      {
        headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
        responseType: 'arraybuffer',
      }
    );
    const imageData = Buffer.from(imgResponse.data).toString('base64');
    userMessage = '（客人傳了一張圖片）';
    messageContent = [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: imageData },
      },
      {
        type: 'text',
        text: '請分析這張圖片，並根據我們的課程給予相關建議。',
      },
    ];
  }

  // 組合歷史訊息 + 這次的訊息
  const messages = [
    ...history.map(h => ({
      role: h.role,
      content: h.content,
    })),
    {
      role: 'user',
      content: messageContent,
    },
  ];

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1000,
    system: SYSTEM_PROMPT,
    messages,
  });

  const replyText = response.content[0].text;
  const cleanReply = replyText.replace('【需要人工處理】', '').trim();

  // 寫入對話記錄
  await appendConversation(spreadsheetId, userId, 'user', userMessage);
  await appendConversation(spreadsheetId, userId, 'assistant', cleanReply);

  await notifyGroup(userMessage, cleanReply, destination);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Linda Bot 啟動成功！Port: ${PORT}`);
});