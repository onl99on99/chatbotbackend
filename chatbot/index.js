const express = require('express');
const { WebhookClient } = require('dialogflow-fulfillment');
const { MongoClient } = require('mongodb');

const uri = process.env.MONGO_URI; 
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
        return false;
    }
}

let dbConnected = false;
connectToDatabase().then(result => { dbConnected = result; });

async function getTeacherInfo(teacherName) {
    if (!dbConnected) return null; 
    try {
        const database = client.db('schooldata'); 
        const teachers = database.collection('teachers');
        const query = { 名稱: { $regex: teacherName, $options: 'i' } };
        const teacher = await teachers.findOne(query);
        return teacher;
    } catch (error) {
        console.error("Error querying database:", error);
        return null;
    }
}

async function handleGetTeacherInfo(agent) {
    if (!dbConnected) {
        agent.add('資料庫連線失敗');
        return;
    }
    
    const teacherName = agent.parameters.teacherName;
    
    if (!teacherName || teacherName.trim() === "") {
        agent.add('請提供老師姓名');
        return;
    }
    
    const teacher = await getTeacherInfo(teacherName);
    
    if (teacher) {
        // 🔥 直接把整個 JSON 物件轉成字串丟出來（最原始、最醜的版本）
        agent.add(JSON.stringify(teacher, null, 2));
    } else {
        agent.add(`查無此老師: ${teacherName}`);
    }
}

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Basic Webhook Server Running');
});

app.post('/webhook', (request, response) => {
    const agent = new WebhookClient({ request, response });
    
    function welcome(agent) {
        agent.add('歡迎使用');
    }
    
    let intentMap = new Map();
    intentMap.set('Default Welcome Intent', welcome);
    intentMap.set('GetTeacherInfo', handleGetTeacherInfo);
    
    agent.handleRequest(intentMap);
});

const port = process.env.PORT || 5000;
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});
