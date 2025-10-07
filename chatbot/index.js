const express = require('express');
const { WebhookClient } = require('dialogflow-fulfillment');
const { MongoClient } = require('mongodb');

// Get connection string from environment variables
const uri = process.env.MONGO_URI;

// Create a new MongoClient with SSL options
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

// Initialize database connection when server starts (non-blocking)
let dbConnected = false;
connectToDatabase().then(result => {
    dbConnected = result;
}).catch(err => {
    console.log("Database connection will be retried later...");
});

// --- MongoDB Query Logic ---
async function getTeacherInfo(teacherName) {
    if (!dbConnected) {
        return null; 
    }
    try {
        const database = client.db('schooldata'); 
        const teachers = database.collection('teachers');
        const query = { 名稱: teacherName };
        const teacher = await teachers.findOne(query);
        return teacher;
    } catch (error) {
        console.error("Error querying database:", error);
        return null;
    }
}

async function handleGetTeacherInfo(agent) {
    if (!dbConnected) {
        agent.add('抱歉，目前資料庫連接有問題，無法查詢老師資訊。');
        return;
    }

    const teacherName = agent.parameters.teacherName;
    if (!teacherName) {
        agent.add('請告訴我你想查詢哪位老師的資訊，例如：「尹邦慶教授」。');
        return;
    }

    const teacher = await getTeacherInfo(teacherName);
    if (teacher) {
        let response = `${teacher.名稱}的辦公室在${teacher.辦公室}，分機號碼是${teacher.分機}。`;

        // 如果有在校日子，就加入回答
        if (teacher['在校日子']) {
            response += `老師通常會在${teacher['在校日子']}在學校。`;
        }

        // 如果有任教課程，就列出課程
        if (teacher['任教課程'] && teacher['任教課程'].length > 0) {
            const courses = teacher['任教課程'].map(course => {
                let courseInfo = `${course['課程名稱']}`;
                if (course['授課教室']) {
                    courseInfo += `，在${course['授課教室']}上課`;
                }
                return courseInfo;
            }).join('；');
            response += `\n老師任教的課程有：${courses}。`;
        }

        agent.add(response);
    } else {
        agent.add(`抱歉，找不到名為 ${teacherName} 的老師。`);
    }
}

// --- Express Server and Webhook ---
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Dialogflow Webhook Server is running!');
});

app.post('/webhook', (request, response) => {
    const agent = new WebhookClient({ request, response });

    function welcome(agent) {
        agent.add(`你好！我已經成功運行了。`);
    }

    let intentMap = new Map();
    intentMap.set('Default Welcome Intent', welcome);
    intentMap.set('GetTeacherInfo', handleGetTeacherInfo); 

    agent.handleRequest(intentMap);
});

const port = process.env.PORT || 5000;
app.listen(port, () => {
    console.log(`Dialogflow webhook server listening on port ${port}`);
});