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

async function getTeacherInfo(teacherName) {
    if (!dbConnected) return null; 
    try {
        const database = client.db('schooldata'); 
        const teachers = database.collection('teachers');
        const query = { 名稱: { $regex: teacherName, $options: 'i' } };
        const teacher = await teachers.findOne(query);
        return teacher;
    } catch (error) {
        console.error("❌ Error querying database:", error);
        return null;
    }
}

async function getAllTeacherNames() {
    if (!dbConnected) return [];
    try {
        const database = client.db('schooldata');
        const teachers = database.collection('teachers');
        const namesCursor = teachers.find({}, { projection: { 名稱: 1, _id: 0 } });
        const namesArray = await namesCursor.toArray();
        return namesArray.map(doc => doc.名稱);
    } catch (error) {
        console.error("❌ Error fetching all teacher names:", error);
        return [];
    }
}

// --- Gemini API 核心 ---

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

// --- 智慧糾錯（查不到老師時使用）---

async function handleTeacherNotFound(originalName, maxTime = 2500) {
    const allNames = await getAllTeacherNames();
    if (allNames.length === 0) {
        return { correctedName: null, suggestionText: null };
    }

    const nameList = allNames.join('、');
    const prompt = `你是校園學長姐。使用者想找"${originalName}"，但名單裡沒有這個人。
請從這個名單找最接近的名字："${nameList}"

如果找到相似的：
- 用幽默方式反問，例如「學弟妹，你是不是想找 **尹邦嚴** 教授啊？」
- **重要**：用 **名字** 標記正確的老師名

如果找不到相似的：
- 客氣告知找不到，建議檢查名字

回答：`;
    
    console.log(`🤖 啟動智慧糾錯："${originalName}"，限時 ${maxTime}ms`);

    try {
        const correctionResponse = await callGeminiAPI(prompt, maxTime);
        if (!correctionResponse) {
            return { correctedName: null, suggestionText: null };
        }

        // 提取粗體字中的老師名
        const correctedMatch = correctionResponse.match(/\*\*(.*?)\*\*/);
        const correctedName = correctedMatch ? correctedMatch[1] : null;

        console.log(`✅ 糾錯結果：${correctedName ? `找到 "${correctedName}"` : '找不到相似名字'}`);

        return { 
            correctedName: correctedName, 
            suggestionText: correctionResponse.trim()
        };
    } catch (error) {
        console.error("❌ Gemini 糾錯失敗:", error.message);
        return { correctedName: null, suggestionText: null };
    }
}

// --- Gemini 回應生成 ---

async function generateTeacherResponse(userQuery, teacherData, maxTime, needsCorrection = false, originalInput = null) {
    let dataString = `名稱: ${teacherData.名稱}, 辦公室: ${teacherData.辦公室}, 分機: ${teacherData.分機}`;
    if (teacherData['在校日子']) { 
        dataString += `, 在校日子: ${teacherData['在校日子']}`; 
    }
    if (teacherData['任教課程'] && teacherData['任教課程'].length > 0) {
        const courses = teacherData['任教課程'].map(c => {
            let courseInfo = c['課程名稱'];
            if (c['課程編號']) { 
                courseInfo += ` (${c['課程編號']})`; 
            } else if (c['授課教室']) { 
                courseInfo += ` (在${c['授課教室']})`; 
            }
            return courseInfo;
        }).join('、');
        dataString += `, 任教課程: ${courses}`;
    }

    // 🔥 錯字提示（只在需要時加入）
    let typoHint = '';
    if (needsCorrection && originalInput && originalInput !== teacherData.名稱) {
        typoHint = `\n\n【提示】：使用者輸入"${originalInput}"，正確是"${teacherData.名稱}"。請幽默友善地糾正他，例如「學弟妹，你是不是想找 ${teacherData.名稱} 教授啊？😄」`;
    }

    const prompt = `任務：台灣校園學長姐，用繁體中文、口語化回答。

規則：
1. 根據使用者問題，只提供**相關資訊**（不要全丟）
   - 問辦公室 → 講辦公室和分機
   - 問課程 → 講任教課程
   - 問籠統 → 給完整但簡潔的資訊
2. 多門同名但不同編號的課 = 不同班級，要自然列出
3. **只能**用我提供的資料回答
${typoHint}
---
使用者問題："${userQuery}"
---
資料："${dataString}"
---
你的回答：`;

    console.log(`✨ 使用完整 Gemini（${maxTime}ms）`);
    return await callGeminiAPI(prompt, maxTime);
}

async function generateQuickResponse(userQuery, teacherData, maxTime, needsCorrection = false, originalInput = null) {
    let dataString = `名稱: ${teacherData.名稱}, 辦公室: ${teacherData.辦公室}, 分機: ${teacherData.分機}`;
    if (teacherData['任教課程'] && teacherData['任教課程'].length > 0) {
        const courses = teacherData['任教課程'].map(c => c['課程名稱']).join('、');
        dataString += `, 課程: ${courses}`;
    }

    let typoHint = (needsCorrection && originalInput) 
        ? `（使用者打"${originalInput}"，正確是"${teacherData.名稱}"，請簡短友善糾正）` 
        : '';

    const prompt = `台灣校園學長姐，繁體中文、口語化。資料："${dataString}"${typoHint}
使用者問："${userQuery}"
簡短回答（根據問題給相關資訊）：`;

    console.log(`⚡ 使用快速 Gemini（${maxTime}ms）`);
    return await callGeminiAPI(prompt, maxTime);
}

async function generateFallbackResponse(userQuery) {
    const prompt = `你是台灣校園學長姐，剛收到與職責無關的問題（天氣、閒聊、政治等）。
俏皮、禮貌地拒絕，提醒只能回答老師/校園資訊。

使用者問："${userQuery}"
你的俏皮回絕：`;

    console.log("💬 Fallback 回應");
    return await callGeminiAPI(prompt, 3000);
}

// --- 備案回應（Gemini 完全失敗時）---

function buildFallbackResponse(teacher, userQuery, wasTypoCorrected = false, originalInput = null) {
    let response = '';
    
    // 如果有糾錯，先加上友善提示
    if (wasTypoCorrected && originalInput) {
        response = `學弟妹，你是不是要找 **${teacher.名稱}** 老師？\n\n`;
    } else {
        response = `找到了！`;
    }
    
    const queryLower = userQuery.toLowerCase();
    
    if (queryLower.includes('辦公室') || queryLower.includes('在哪') || queryLower.includes('位置')) {
        response += `${teacher.名稱}老師的辦公室在 ${teacher.辦公室}，分機是 ${teacher.分機} 喔～`;
    } else if (queryLower.includes('課') || queryLower.includes('教什麼')) {
        if (teacher['任教課程'] && teacher['任教課程'].length > 0) {
            const courses = teacher['任教課程'].map(c => c['課程名稱']).join('、');
            response += `${teacher.名稱}老師教 ${courses}。想知道更多可以到 ${teacher.辦公室} 找老師！`;
        } else {
            response += `${teacher.名稱}老師在 ${teacher.辦公室}，分機 ${teacher.分機}～`;
        }
    } else {
        response += `${teacher.名稱}老師在 ${teacher.辦公室}，分機是 ${teacher.分機}`;
        if (teacher['任教課程'] && teacher['任教課程'].length > 0) {
            const mainCourse = teacher['任教課程'][0]['課程名稱'];
            response += `，教 ${mainCourse}`;
            if (teacher['任教課程'].length > 1) {
                response += ` 等課程`;
            }
        }
        response += `！`;
    }
    
    return response;
}

// --- 主要 Webhook 處理 ---

async function handleGetTeacherInfo(agent) {
    if (!dbConnected) {
        agent.add('哎呀！我的資料庫連線好像睡著了，稍後再試一次喔！');
        return;
    }
    
    const teacherName = agent.parameters.teacherName;
    const userQuery = agent.query;

    if (!teacherName || teacherName.trim() === "") {
        agent.add('你要問哪位老師呀？給我全名我才好幫你查～');
        return;
    }

    const startTime = Date.now();
    const TOTAL_TIMEOUT = 4600; // 留 0.4 秒緩衝
    
    console.log(`\n🔍 使用者查詢："${userQuery}"`);
    console.log(`📝 提取參數：teacherName="${teacherName}"`);

    try {
        // ===== Step 1: 查詢資料庫 =====
        let teacher = await getTeacherInfo(teacherName);
        let dbTime = Date.now() - startTime;
        console.log(`📊 資料庫查詢耗時：${dbTime}ms`);
        
        let wasTypoCorrected = false;
        let originalInput = teacherName;
        let correctionText = null;
        
        // ===== Step 1A: 查不到，啟動智慧糾錯 =====
        if (!teacher) {
            console.log(`❌ MongoDB 查無資料，啟動智慧糾錯...`);
            
            const correctionStartTime = Date.now();
            const maxCorrectionTime = Math.min(2500, TOTAL_TIMEOUT - dbTime - 2000); // 最多 2.5 秒，且要留 2 秒給後續
            
            const correctionResult = await handleTeacherNotFound(teacherName, maxCorrectionTime);
            const correctionTime = Date.now() - correctionStartTime;
            console.log(`⏱️ 糾錯耗時：${correctionTime}ms`);
            
            if (correctionResult.correctedName) {
                // 糾錯成功！
                console.log(`✅ 糾錯成功："${teacherName}" → "${correctionResult.correctedName}"`);
                
                originalInput = teacherName;
                teacherName = correctionResult.correctedName;
                wasTypoCorrected = true;
                correctionText = correctionResult.suggestionText;
                
                // 用正確名字重新查詢
                teacher = await getTeacherInfo(correctionResult.correctedName);
                dbTime = Date.now() - startTime;
                
                if (!teacher) {
                    console.log(`❌ 糾錯後仍查無資料！`);
                    agent.add(`${correctionText}\n\n但奇怪的是，我的資料庫裡還是找不到這位老師的詳細資料...`);
                    return;
                }
            } else {
                // 糾錯失敗，真的找不到
                console.log(`❌ 糾錯失敗，確定找不到`);
                const response = correctionResult.suggestionText || 
                                `嗯... 我在學校通訊錄裡找不到 ${teacherName} 耶，你要不要檢查一下名字？`;
                agent.add(response);
                return;
            }
        }
        
        // ===== 程式執行到這裡，代表已經有有效的 teacher 物件 =====
        
        console.log(`✅ 找到老師：${teacher.名稱}`);
        
        // ===== Step 2: 計算剩餘時間 =====
        const remainingTime = TOTAL_TIMEOUT - (Date.now() - startTime);
        console.log(`⏱️ 剩餘時間：${remainingTime}ms`);
        
        let response = null;
        
        // ===== Step 3: 根據剩餘時間選擇策略 =====
        if (remainingTime >= 2800) {
            // 策略 A：完整 Gemini
            response = await generateTeacherResponse(
                userQuery, 
                teacher, 
                remainingTime - 400, 
                wasTypoCorrected, 
                originalInput
            );
        } else if (remainingTime >= 1500) {
            // 策略 B：快速 Gemini
            response = await generateQuickResponse(
                userQuery, 
                teacher, 
                remainingTime - 300, 
                wasTypoCorrected, 
                originalInput
            );
        } else {
            console.log(`⏰ 時間不足（${remainingTime}ms），直接使用備案`);
        }
        
        // ===== Step 4: 處理回應 =====
        const totalTime = Date.now() - startTime;
        
        if (response) {
            console.log(`✅ Gemini 成功！總耗時：${totalTime}ms`);
            
            // 如果有糾錯建議文字，先顯示
            if (correctionText) {
                agent.add(correctionText + '\n\n' + response);
            } else {
                agent.add(response);
            }
        } else {
            // Gemini 失敗或時間不足，使用備案
            console.log(`⚠️ 使用備案回應。總耗時：${totalTime}ms`);
            const fallback = buildFallbackResponse(teacher, userQuery, wasTypoCorrected, originalInput);
            
            if (correctionText && !wasTypoCorrected) {
                agent.add(correctionText + '\n\n' + fallback);
            } else {
                agent.add(fallback);
            }
        }
        
    } catch (error) {
        console.error("❌ Error in handleGetTeacherInfo:", error);
        agent.add('哎呀，查詢時出了點問題，請稍後再試一次！');
    }
}

async function handleFallback(agent) {
    console.log(`💬 Default Fallback Intent。查詢: "${agent.query}"`);
    const query = agent.query;
    const livelyRefusal = await generateFallbackResponse(query);
    
    if (livelyRefusal) {
        agent.add(livelyRefusal);
    } else {
        agent.add("嗯... 這個問題我真的不太清楚耶，你可以試著問我關於老師的資訊嗎？");
    }
}

// --- Express 伺服器 ---
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    res.send('🚀 Dialogflow Webhook (v8.0 - Fixed) Running!');
});

app.post('/webhook', (request, response) => {
    const agent = new WebhookClient({ request, response });
    
    function welcome(agent) {
        agent.add(`你好！我是你的校園助理，有什麼問題儘管問我吧！`);
    }
    
    let intentMap = new Map();
    intentMap.set('Default Welcome Intent', welcome);
    intentMap.set('GetTeacherInfo', handleGetTeacherInfo); 
    intentMap.set('Default Fallback Intent', handleFallback);
    
    agent.handleRequest(intentMap);
});

const port = process.env.PORT || 5000;
app.listen(port, () => {
    console.log(`\n🚀 Dialogflow Webhook v8.0 listening on port ${port}`);
    console.log(`📊 策略：`);
    console.log(`   1. 查無資料 → 智慧糾錯（最多 2.5 秒）`);
    console.log(`   2. 時間 ≥ 2.8秒 → 完整 Gemini`);
    console.log(`   3. 時間 ≥ 1.5秒 → 快速 Gemini`);
    console.log(`   4. 時間不足 → 智慧備案\n`);
});
