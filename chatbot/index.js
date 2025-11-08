const express = require('express');
const { WebhookClient } = require('dialogflow-fulfillment');
const { MongoClient } = require('mongodb');
// ！！！新增：我們需要 node-fetch 來呼叫 Gemini API！！！
const fetch = require('node-fetch');

// --- Gemini API 設定 ---
// 我們將使用 gemini-2.5-flash-preview-09-2025 模型
// ！！！我們將從 Render 的環境變數讀取 API Key，而不是寫死在這裡！！！
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`;

// --- MongoDB 設定 (不變) ---
const uri = process.env.MONGO_URI; // 從 Render 環境變數讀取
const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
    maxPoolSize: 10,
});

async function connectToDatabase() {
    try {
        await client.connect();
        console.log("✅ Successfully connected to MongoDB!");
        await client.db("admin").command({ ping: 1 });
        console.log("✅ MongoDB ping successful!");
        return true;
    } catch (err) {
        console.error("❌ Failed to connect to MongoDB:", err.message);
        console.log("🚀 Server will continue running without database connection");
        return false;
    }
}

let dbConnected = false;
connectToDatabase().then(result => {
    dbConnected = result;
}).catch(err => {
    console.log("Database connection will be retried later...");
});

// --- MongoDB 查詢邏輯 (不變) ---
async function getTeacherInfo(teacherName) {
    if (!dbConnected) return null; 
    try {
        const database = client.db('schooldata'); 
        const teachers = database.collection('teachers');
        // 使用正規表達式進行模糊查詢，'i' 表示不區分大小寫
        // 這可以讓使用者輸入 "尹邦慶" 或 "尹邦慶教授" 都能找到
        const query = { 名稱: { $regex: teacherName, $options: 'i' } };
        const teacher = await teachers.findOne(query);
        return teacher;
    } catch (error) {
        console.error("Error querying database:", error);
        return null;
    }
}

// --- 呼叫 Gemini API 的新函式 ---
async function generateLivelyResponse(userQuery, teacherData) {
    let dataString = `名稱: ${teacherData.名稱}, 辦公室: ${teacherData.辦公室}, 分機: ${teacherData.分機}`;
    
    // 動態加入額外資訊
    if (teacherData['在校日子']) {
        dataString += `, 在校日子: ${teacherData['在校日子']}`;
    }
    if (teacherData['任教課程'] && teacherData['任教課程'].length > 0) {
        const courses = teacherData['任教課程'].map(c => c['課程名稱']).join(', ');
        dataString += `, 任教課程: ${courses}`;
    }

    // 建立提示 (Prompt)
    const prompt = `
        任務：扮演一個友善、熱心、且有點俏皮的台灣校園學長姐。
        規則：
        1.  使用繁體中文。
        2.  語氣必須非常口語化、生動活潑，像在跟學弟妹聊天。
        3.  根據提供的「資料」，簡潔地回答「使用者的問題」。
        4.  如果資料不夠回答，就俏皮地說你只知道資料上的部分。
        
        使用者的問題："${userQuery}"
        
        你要用的資料："${dataString}"
        
        你的回答：`;

    console.log("Sending prompt to Gemini:", prompt);

    try {
        const payload = {
            contents: [{ parts: [{ text: prompt }] }],
            // 可以在此加入 safetySettings
        };

        const response = await fetch(GEMINI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Gemini API request failed with status ${response.status}: ${errorBody}`);
        }

        const result = await response.json();
        
        if (!result.candidates || !result.candidates[0].content || !result.candidates[0].content.parts) {
             console.error("Gemini response is empty or malformed:", result);
             return null; // 結構不符
        }
        
        const text = result.candidates[0].content.parts[0].text;
        
        console.log("Gemini response:", text);
        return text.trim();

    } catch (error) {
        console.error("Gemini API call failed:", error.message);
        return null; // 失敗時回傳 null
    }
}

// --- Webhook 處理 (已升級) ---
async function handleGetTeacherInfo(agent) {
    if (!dbConnected) {
        agent.add('哎呀！我的資料庫連線好像睡著了，稍後再試一次喔！');
        return;
    }

    // 從 Dialogflow 取得參數
    const teacherName = agent.parameters.teacherName;
    if (!teacherName) {
        agent.add('你要問哪位老師呀？給我全名我才好幫你查～');
        return;
    }

    // 1. 查詢 MongoDB
    const teacher = await getTeacherInfo(teacherName);
    if (teacher) {
        // 2. 查詢到資料 -> 呼叫 Gemini API
        const userQuery = agent.query; // 取得使用者的原始問題
        const livelyResponse = await generateLivelyResponse(userQuery, teacher);

        if (livelyResponse) {
            agent.add(livelyResponse); // 使用 AI 生成的「生動」回覆
        } else {
            // 3. Gemini API 失敗 -> 退回「死板」的模板回覆
            let fallbackResponse = `${teacher.名稱}老師的辦公室在${teacher.辦公室}，分機是${teacher.分機}。`;
            agent.add(`哎呀，我的創意大腦剛好當機了... 不過我查到：\n${fallbackResponse}`);
        }
    } else {
        // 4. MongoDB 查不到資料
        agent.add(`嗯... 我在學校通訊錄裡找不到 ${teacherName} 耶，你要不要檢查一下名字有沒有打錯？`);
    }
}

// --- Express 伺服器 (不變) ---
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Dialogflow Webhook Server is running (v3 - Gemini Powered)!');
});

app.post('/webhook', (request, response) => {
    const agent = new WebhookClient({ request, response });

    function welcome(agent) {
        agent.add(`你好！我是你的校園助理，有什麼問題儘管問我吧！(Gemini版)`);
    }

    let intentMap = new Map();
    intentMap.set('Default Welcome Intent', welcome);
    intentMap.set('GetTeacherInfo', handleGetTeacherInfo); 
    // 你可以在這裡加入更多意圖，例如 handleGetEventInfo
    agent.handleRequest(intentMap);
});

const port = process.env.PORT || 5000;
app.listen(port, () => {
    console.log(`Dialogflow webhook server (Gemini v3) listening on port ${port}`);
});
