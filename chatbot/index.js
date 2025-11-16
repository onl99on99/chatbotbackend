const express = require('express');
const { WebhookClient } = require('dialogflow-fulfillment');
const { MongoClient } = require('mongodb');

// --- 設置 (移除 Gemini 相關) ---
const uri = process.env.MONGO_URI; 
const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
    maxPoolSize: 10,
});

// --- 資料庫連線 ---
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
connectToDatabase().then(result => { dbConnected = result; });

// --- 資料庫查詢 ---
async function getTeacherInfo(teacherName) {
    if (!dbConnected) return null; 
    try {
        const database = client.db('schooldata'); 
        const teachers = database.collection('teachers');
        // 使用模糊匹配
        const query = { 名稱: { $regex: teacherName, $options: 'i' } };
        const teacher = await teachers.findOne(query);
        return teacher;
    } catch (error) {
        console.error("Error querying database:", error);
        return null;
    }
}

// --- Webhook 主要處理函數 (舊版 - 笨邏輯) ---
async function handleGetTeacherInfo(agent) {
    if (!dbConnected) {
        agent.add('哎呀！我的資料庫連線好像睡著了，稍後再試一次喔！');
        return;
    }
        
    const teacherName = agent.parameters.teacherName;
    if (!teacherName || teacherName.trim() === "") {
        agent.add('你要問哪位老師呀？給我全名我才好幫你查～');
        return;
    }

    try {
        // Step 1: 查詢資料庫
        const teacher = await getTeacherInfo(teacherName);
                
        if (!teacher) {
            // 查不到的舊版回覆
            agent.add(`嗯... 我在學校通訊錄裡找不到 ${teacherName} 耶，你要不要檢查一下名字？`);
            return;
        }

        // Step 2: 舊版的「資料全丟」字串拼接
        // (這就是你要的「可讀性低」的回覆)
        let responseText = `找到了！${teacher.名稱}老師。`;
        
        if (teacher.辦公室) {
            responseText += ` 辦公室在 ${teacher.辦公室}`;
        }
        if (teacher.分機) {
            responseText += `，分機是 ${teacher.分機}。`;
        }
        if (teacher['在校日子']) {
            responseText += ` 常在的日子是 ${teacher['在校日子']}。`;
        }
        if (teacher['任教課程'] && teacher['任教課程'].length > 0) {
            const courses = teacher['任教課程'].map(c => c['課程名稱']).join('、');
            responseText += ` 他教 ${courses}。`;
        }
        responseText += " 想知道更多可以去找老師！"; // 加上一個罐頭結尾

        // Step 3: 回傳生硬的字串
        agent.add(responseText);
            
    } catch (error) {
        console.error("❌ Error in handleGetTeacherInfo (Old Version):", error);
        agent.add('哎呀，查詢時出了點問題，請稍後再試一次！');
    }
}

// --- Fallback (舊版 - 罐頭訊息) ---
async function handleFallback(agent) {
    agent.add("嗯... 這個問題我真的不太清楚耶，你可以試著問我關於老師的資訊嗎？");
}

// --- Express 伺服器設定 ---
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Dialogflow Webhook Server is running (OLD VERSION - MongoDB Only)!');
});

app.post('/webhook', (request, response) => {
    const agent = new WebhookClient({ request, response });
    
    function welcome(agent) {
        agent.add(`你好！我是你的校園助理！(舊版)`);
    }
    
    let intentMap = new Map();
    intentMap.set('Default Welcome Intent', welcome);
    intentMap.set('GetTeacherInfo', handleGetTeacherInfo); 
    intentMap.set('Default Fallback Intent', handleFallback);
    
    agent.handleRequest(intentMap);
});

const port = process.env.PORT || 5000;
app.listen(port, () => {
    console.log(`🚀 Dialogflow webhook server (OLD VERSION - MongoDB Only) listening on port ${port}`);
});
```eof

你只要把這個檔案部署到 Render，然後去 Dialogflow 測試，就能完美重現你想要的「**資料全丟、可讀性低**」的舊版截圖了。

再次為我之前的卡住道歉！
