const express = require('express');
const { WebhookClient } = require('dialogflow-fulfillment');
const { MongoClient } = require('mongodb');
const fetch = require('node-fetch');

// --- 設定與連線 ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; 
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`;

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
        console.log("🚀 Server will continue running without database connection");
        return false;
    }
}
let dbConnected = false;
connectToDatabase().then(result => { dbConnected = result; });

// --- 輔助函數：資料庫查詢 ---

/**
 * 查詢老師資訊，使用模糊匹配
 * @param {string} teacherName Dialogflow提取的老師名字 (可能包含錯字)
 */
async function getTeacherInfo(teacherName) {
    if (!dbConnected) return null; 
    try {
        const database = client.db('schooldata'); 
        const teachers = database.collection('teachers');
        // 使用 case-insensitive regex 進行模糊匹配
        const query = { 名稱: { $regex: teacherName, $options: 'i' } };
        const teacher = await teachers.findOne(query);
        return teacher;
    } catch (error) {
        console.error("Error querying database:", error);
        return null;
    }
}

/**
 * 獲取所有老師名稱 (用於給 Gemini 進行糾錯的候選名單)
 * @returns {Array<string>} 所有老師的名稱列表
 */
async function getAllTeacherNames() {
    if (!dbConnected) return [];
    try {
        const database = client.db('schooldata');
        const teachers = database.collection('teachers');
        // 只投影 '名稱' 欄位
        const namesCursor = teachers.find({}, { projection: { 名稱: 1, _id: 0 } });
        const namesArray = await namesCursor.toArray();
        return namesArray.map(doc => doc.名稱);
    } catch (error) {
        console.error("Error fetching all teacher names:", error);
        return [];
    }
}


// --- 輔助函數：Gemini API 呼叫核心 ---

/**
 * 核心 API 呼叫函數，包含超時處理
 * @param {string} prompt 要傳送給 Gemini 的提示詞
 * @param {number} timeoutMs 超時時間 (毫秒)
 * @returns {Promise<string|null>} 生成的文字或 null (如果超時/失敗)
 */
async function callGeminiAPI(prompt, timeoutMs = 3500) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
        const payload = { 
            contents: [{ parts: [{ text: prompt }] }],
            safetySettings: [
                { "category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_ONLY_HIGH" },
                { "category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_ONLY_HIGH" },
                { "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_ONLY_HIGH" },
                { "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_ONLY_HIGH" }
            ]
        };
        
        const response = await fetch(GEMINI_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) { 
            const errorBody = await response.text();
            throw new Error(`Gemini API request failed ${response.status}: ${errorBody}`); 
        }
        
        const result = await response.json();
        
        if (result.candidates && result.candidates[0].finishReason === 'SAFETY') {
            console.warn("⚠️ Gemini 拒絕回答 (安全設定)");
            return null;
        }
        
        if (!result.candidates || !result.candidates[0].content) { 
            throw new Error("Invalid Gemini response structure"); 
        }
        
        const text = result.candidates[0].content.parts[0].text;
        console.log("✅ Gemini response received.");
        return text.trim();
        
    } catch (error) {
        if (error.name === 'AbortError') {
            console.warn("⏱️ Gemini API 超時");
            return null;
        }
        console.error("❌ Gemini API call failed:", error.message);
        return null;
    }
}


// --- 核心邏輯：Gemini 提示詞生成 ---

/**
 * 完整版 Gemini 回應：詳細的 prompt，用於時間充足時
 */
async function generateTeacherResponse(userQuery, teacherData, maxTime, wasTypoCorrected, originalInput) {
    let dataString = `名稱: ${teacherData.名稱}, 辦公室: ${teacherData.辦公室}, 分機: ${teacherData.分機}`;
    if (teacherData['在校日子']) { dataString += `, 在校日子: ${teacherData['在校日子']}`; }
    if (teacherData['任教課程'] && teacherData['任教課程'].length > 0) {
        const courses = teacherData['任教課程'].map(c => {
            let courseInfo = c['課程名稱'];
            if (c['課程編號']) { courseInfo += ` (${c['課程編號']})`; } 
            else if (c['授課教室']) { courseInfo += ` (在${c['授課教室']})`; }
            return courseInfo;
        }).join('、');
        dataString += `, 任教課程: ${courses}`;
    }

    // 🔥 錯字幽默糾正提示
    let typoHint = '';
    if (wasTypoCorrected && originalInput) {
        typoHint = `\n\n【特別提示】：使用者原本輸入的是"${originalInput}"，但正確名字是"${teacherData.名稱}"。**你必須用幽默、友善的方式糾正他，例如「學弟妹，你是不是想找${teacherData.名稱}教授啊？😄」之類的開場白，然後再提供資訊。**`;
    }

    const prompt = `
任務：扮演一個友善、熱心、且有點俏皮的台灣校園學長姐。

規則：
1. 使用繁體中文，語氣口語化、生動活潑。
2. **嚴格限制**：你**只能**根據我提供的「你要用的資料」來回答「使用者的問題」。
3. **智慧回應**：根據使用者的問題，只提供**相關的資訊**，不要一次把所有資料都丟出去。
    - 如果問辦公室，就重點講辦公室和分機
    - 如果問課程，就重點講任教課程
    - 如果問籠統的問題，再給完整資訊
4. **課程處理規則**：如果「任教課程」中有多門課名稱相同但編號不同，這代表它們是開給**不同班級**的課。你**不應該**說「他的招牌課是...」，而是要自然地把它們都列出來。

${typoHint}
---
使用者的問題："${userQuery}"
---
你要用的資料："${dataString}"
---
你的回答：`;

    console.log("✨ 策略：使用完整 Gemini 回應");
    return await callGeminiAPI(prompt, maxTime);
}

/**
 * 快速版 Gemini 回應：簡化的 prompt，用於時間緊迫時
 */
async function generateQuickResponse(userQuery, teacherData, maxTime, wasTypoCorrected, originalInput) {
    let dataString = `名稱: ${teacherData.名稱}, 辦公室: ${teacherData.辦公室}, 分機: ${teacherData.分機}`;
    if (teacherData['任教課程'] && teacherData['任教課程'].length > 0) {
        const courses = teacherData['任教課程'].map(c => c['課程名稱']).join('、');
        dataString += `, 課程: ${courses}`;
    }

    // 🔥 錯字簡短提示
    let typoHint = wasTypoCorrected && originalInput 
        ? `（使用者原本打"${originalInput}"，正確是"${teacherData.名稱}"。請簡短友善糾正後回答）` 
        : '';

    const prompt = `你是台灣校園學長姐，用繁體中文、口語化回答。只用這些資料："${dataString}"${typoHint}
使用者問："${userQuery}"
簡短回答（根據問題提供相關資訊，不要全丟）：`;

    console.log("⚡ 策略：使用快速 Gemini 回應");
    return await callGeminiAPI(prompt, maxTime);
}

/**
 * Fallback 回應：用於處理與職責無關的閒聊
 */
async function generateFallbackResponse(userQuery) {
    const prompt = `
任務：扮演一個友善、熱心、且有點俏皮的台灣校園學長姐。
規則：你剛剛收到一個**與你職責無關**的問題 (例如問天氣、閒聊、寫詩、政治等)。
你的任務是：**俏皮地、有禮貌地拒絕回答**，並**提醒**使用者你只能幫忙回答「老師」或「校園」相關的問題。

---
使用者的無關問題："${userQuery}"
---
你的俏皮回絕：`;

    console.log("Sending Fallback prompt to Gemini");
    return await callGeminiAPI(prompt, 3000);
}

/**
 * 智慧糾錯：當 MongoDB 查詢失敗時，詢問 Gemini 是否能猜到正確名字
 */
async function handleTeacherNotFound(originalName) {
    const allNames = await getAllTeacherNames();
    if (allNames.length === 0) {
        return { correctedName: null, response: `同學，我查不到「${originalName}」耶，而且名單也不見了...` };
    }

    const nameList = allNames.join('、');
    const prompt = `
        任務：扮演一個擁有幽默感的校園學長姐，專門幫忙學弟妹糾正他們打錯的老師名字。
        規則：
        1. 使用繁體中文，語氣俏皮、輕鬆。
        2. **分析判斷：** 比較「學弟妹輸入的名字」和「全校老師名單」的相似度。
        3. **如果找到最接近的名字 (糾錯成功)：**
           - **輸出：** 用幽默的方式反問學弟妹，並用**粗體**強調最可能的名字 (例如: "**尹邦嚴**")。
           - **返回：** 返回正確的老師名稱 (例如: "尹邦嚴")。
        4. **如果沒有相似的名字 (糾錯失敗)：**
           - **輸出：** 用客氣的方式告知找不到，並提醒檢查名字。
           - **返回：** 返回 null。
        ---
        學弟妹輸入的名字："${originalName}"
        ---
        全校老師名單："${nameList}"
        ---
        你的回答：`;
    
    console.log(`🤖 啟動智慧糾錯："${originalName}"`);

    try {
        const correctionResponse = await callGeminiAPI(prompt, 3000); // 給 3 秒糾錯時間
        if (!correctionResponse) {
             return { correctedName: null, response: `我的糾錯晶片今天不給力... 真的找不到「${originalName}」耶。` };
        }

        // 檢查回應中是否有粗體字（假設粗體字就是糾正後的老師名）
        const correctedMatch = correctionResponse.match(/\*\*(.*?)\*\*/);
        const correctedName = correctedMatch ? correctedMatch[1] : null;

        return { 
            correctedName: correctedName, 
            response: correctionResponse.trim() 
        };
    } catch (error) {
        console.error("Gemini Correction API call failed:", error.message);
        return { correctedName: null, response: `同學，我的糾錯功能也當機了... 真的找不到「${originalName}」耶。` };
    }
}

// --- Webhook 主要處理函數 ---

async function handleGetTeacherInfo(agent) {
    if (!dbConnected) {
        agent.add('哎呀！我的資料庫連線好像睡著了，稍後再試一次喔！');
        return;
    }
    
    // 參數提取
    const teacherName = agent.parameters.teacherName;
    const userQuery = agent.query;

    if (!teacherName || teacherName.trim() === "") {
        agent.add('你要問哪位老師呀？給我全名我才好幫你查～');
        return;
    }

    const startTime = Date.now();
    const TOTAL_TIMEOUT = 4700; 
    let finalTeacherName = teacherName;
    let originalInput = teacherName; // 初始假設 Dialogflow 提取的就是用戶輸入的

    try {
        // Step 1: 查詢資料庫 (使用 Dialogflow 提取的參數)
        let teacher = await getTeacherInfo(finalTeacherName);
        let wasTypoCorrected = false;
        
        // Step 1A: 查詢失敗，啟動智慧糾錯
        if (!teacher) {
            console.log(`MongoDB 找不到 "${teacherName}"，啟動 Gemini 糾錯...`);
            
            const correctionResult = await handleTeacherNotFound(teacherName);
            
            if (correctionResult.correctedName) {
                // 糾錯成功！
                agent.add(correctionResult.response); // 給出幽默反問的回覆
                
                // 設定旗標，準備用正確的名字重新查詢
                finalTeacherName = correctionResult.correctedName;
                originalInput = teacherName; // 記錄錯字輸入，用於後續提示
                wasTypoCorrected = true; 
                
                // 重新查詢資料庫 (用正確的名字)
                teacher = await getTeacherInfo(finalTeacherName);
            } else {
                // 糾錯失敗 (真的找不到)
                agent.add(correctionResult.response);
                return;
            }
        }
        
        // --------------------------------------------------------------------------------
        // 程式執行到這裡，代表我們已經有了一個有效的 `teacher` 物件 (無論是直接查到還是糾錯後查到)
        // --------------------------------------------------------------------------------

        const dbTime = Date.now() - startTime;
        console.log(`📊 資料庫最終查詢耗時：${dbTime}ms`);

        // Step 2: 計算剩餘時間
        const remainingTime = TOTAL_TIMEOUT - dbTime;
        console.log(`⏱️ 剩餘時間：${remainingTime}ms`);
        
        let response = null;

        // Step 3: 根據剩餘時間選擇策略
        if (remainingTime >= 3000) {
            response = await generateTeacherResponse(userQuery, teacher, remainingTime - 500, wasTypoCorrected, originalInput);
        } else if (remainingTime >= 1500) {
            response = await generateQuickResponse(userQuery, teacher, remainingTime - 300, wasTypoCorrected, originalInput);
        }

        // Step 4: 處理回應
        if (response) {
            const totalTime = Date.now() - startTime;
            console.log(`✅ 成功！總耗時：${totalTime}ms`);
            agent.add(response);
        } else {
            // 情況 C：Gemini 失敗或時間真的不夠，使用最後備案
            console.log("⚠️ 降級：使用最後備案（但加上友善語氣）");
            const totalTime = Date.now() - startTime;
            console.log(`⏱️ 總耗時：${totalTime}ms`);
            
            // 保持友善語氣的備案
            let friendlyResponse = `找到了！`;
            const queryLower = userQuery.toLowerCase();
            
            // 根據用戶問題智慧選擇要顯示的資訊 (與你原程式碼的邏輯相同)
            if (queryLower.includes('辦公室') || queryLower.includes('在哪') || queryLower.includes('位置')) {
                friendlyResponse += `${teacher.名稱}老師的辦公室在 ${teacher.辦公室}，分機是 ${teacher.分機} 喔～`;
            } else if (queryLower.includes('課') || queryLower.includes('教什麼')) {
                if (teacher['任教課程'] && teacher['任教課程'].length > 0) {
                    const courses = teacher['任教課程'].map(c => c['課程名稱']).join('、');
                    friendlyResponse += `${teacher.名稱}老師教 ${courses}。想知道更多可以到 ${teacher.辦公室} 找老師！`;
                } else {
                    friendlyResponse += `${teacher.名稱}老師在 ${teacher.辦公室}，分機 ${teacher.分機}～`;
                }
            } else {
                friendlyResponse += `${teacher.名稱}老師在 ${teacher.辦公室}，分機是 ${teacher.分機}`;
                if (teacher['任教課程'] && teacher['任教課程'].length > 0) {
                    const mainCourse = teacher['任教課程'][0]['課程名稱'];
                    friendlyResponse += `，教 ${mainCourse}`;
                    if (teacher['任教課程'].length > 1) {
                        friendlyResponse += ` 等課程`;
                    }
                }
                friendlyResponse += `！`;
            }
            
            // 如果是糾錯後進入備案，加上提示
            if (wasTypoCorrected) {
                 friendlyResponse = `（雖然我的智慧生成當機了，但你是不是要找${teacher.名稱}老師？他的資訊在這裡：）\n${friendlyResponse}`;
            }

            agent.add(friendlyResponse);
        }
        
    } catch (error) {
        console.error("❌ Error in handleGetTeacherInfo:", error);
        agent.add('哎呀，查詢時出了點問題，請稍後再試一次！');
    }
}

/**
 * Default Fallback Intent 處理函數
 */
async function handleFallback(agent) {
    console.log(`觸發了 Default Fallback Intent。使用者查詢: "${agent.query}"`);
    const query = agent.query;
    const livelyRefusal = await generateFallbackResponse(query);
    
    if (livelyRefusal) {
        agent.add(livelyRefusal);
    } else {
        agent.add("嗯... 這個問題我真的不太清楚耶，你可以試著問我關於老師的資訊嗎？");
    }
}

// --- Express 伺服器設定 ---
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Dialogflow Webhook Server is running (v7.1 - Smart Correction & Timeout)! 🚀');
});

app.post('/webhook', (request, response) => {
    const agent = new WebhookClient({ request, response });
    
    function welcome(agent) {
        agent.add(`你好！我是你的校園助理，有什麼問題儘管問我吧！(v7.1 智慧版)`);
    }
    
    let intentMap = new Map();
    intentMap.set('Default Welcome Intent', welcome);
    intentMap.set('GetTeacherInfo', handleGetTeacherInfo); 
    intentMap.set('Default Fallback Intent', handleFallback);
    
    agent.handleRequest(intentMap);
});

const port = process.env.PORT || 5000;
app.listen(port, () => {
    console.log(`🚀 Dialogflow webhook server (v7.1) listening on port ${port}`);
    console.log(`📊 策略說明：`);
    console.log(`   - 查無資料：啟動 Gemini 智慧糾錯`);
    console.log(`   - 時間充足：完整 Gemini（詳細回應）`);
    console.log(`   - 時間緊迫：快速 Gemini（智慧但簡潔）`);
    console.log(`   - 時間不足：智慧備案（非罐頭訊息）`);
});
