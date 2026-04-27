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

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const GROUP_ID = process.env.LINE_GROUP_ID;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// 讀取 Google 試算表課程資料
async function getCourseData() {
  try {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    // 讀取課程資料
    const courseRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: '課程!A1:L20',
    });

    // 讀取 FAQ 資料
    const faqRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'FAQ!A1:B50',
    });

    const courseRows = courseRes.data.values || [];
    const faqRows = faqRes.data.values || [];

    // 整理課程資料
    let courseText = '【目前課程】\n';
    if (courseRows.length > 1) {
      const headers = courseRows[0];
      for (let i = 1; i < courseRows.length; i++) {
        const row = courseRows[i];
        if (!row[0]) continue;
        headers.forEach((header, index) => {
          if (row[index]) {
            courseText += `${header}：${row[index]}\n`;
          }
        });
        courseText += '\n';
      }
    }

    // 整理 FAQ 資料
    let faqText = '【常見問題】\n';
    if (faqRows.length > 1) {
      for (let i = 1; i < faqRows.length; i++) {
        const row = faqRows[i];
        if (!row[0]) continue;
        faqText += `Q：${row[0]}\nA：${row[1] || '請洽專人'}\n\n`;
      }
    }

    return courseText + '\n' + faqText;
  } catch (error) {
    console.error('讀取試算表失敗:', error);
    return '';
  }
}

async function notifyGroup(customerMessage) {
  await client.pushMessage({
    to: GROUP_ID,
    messages: [{
      type: 'text',
      text: `⚠️ 有客人需要人工處理！\n\n客人說：「${customerMessage}」\n\n請盡快回覆！`
    }]
  });
}

app.get('/ping', (req, res) => {
  res.send('OK');
});

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  const events = req.body.events;
  await Promise.all(events.map(handleEvent));
  res.json({ status: 'ok' });
});

async function handleEvent(event) {
  if (event.type !== 'message') return;
  if (event.source.type === 'group' || event.source.type === 'room') return;
  if (event.message.type !== 'text' && event.message.type !== 'image') return;

  // 每次都讀取最新課程資料
  const courseData = await getCourseData();

  const SYSTEM_PROMPT = `
你是「EST168」的客服人員，名字叫做 Linda（琳達）。
無論客人叫你 Linda、LINDA、linda、琳達，都要認得出來。
請用親切、專業的繁體中文回覆，適時使用表情符號。
只回答與課程相關的問題。

${courseData}

【遇到無法回答的問題】
請說：「感謝您的詢問！這個問題我幫您轉給專人處理 😊」
並且在回覆結尾加上：【需要人工處理】
`;

  let messageContent;
  let userMessage = '';

  if (event.message.type === 'text') {
    userMessage = event.message.text;
    messageContent = [{ type: 'text', text: userMessage }];
  } else if (event.message.type === 'image') {
    const imgResponse = await axios.get(
      `https://api-data.line.me/v2/bot/message/${event.message.id}/content`,
      {
        headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
        responseType: 'arraybuffer'
      }
    );
    const imageData = Buffer.from(imgResponse.data).toString('base64');
    userMessage = '（客人傳了一張圖片）';
    messageContent = [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: imageData }
      },
      {
        type: 'text',
        text: '請分析這張圖片，並根據我們的課程給予相關建議。'
      }
    ];
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: messageContent }],
  });

  const replyText = response.content[0].text;

  if (replyText.includes('【需要人工處理】')) {
    await notifyGroup(userMessage);
  }

  const cleanReply = replyText.replace('【需要人工處理】', '').trim();

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: 'text', text: cleanReply }],
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Linda Bot 啟動成功！Port: ${PORT}`);
});