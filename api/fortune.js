/**
 * /api/fortune.js — Vercel Serverless Function
 *
 * 职责：
 *   1. 接收前端发来的命理分析请求（user message）
 *   2. 注入系统提示词（system prompt），调用 LLM API
 *   3. 按 IP 做每日用量限制（防止滥用刷量）
 *   4. 返回 AI 生成的 Markdown 内容
 *
 * 环境变量（在 Vercel 项目设置 → Environment Variables 中配置）：
 *   LLM_API_BASE  — API 地址（默认 DeepSeek）
 *   LLM_API_KEY   — API Key（必填）
 *   LLM_MODEL     — 模型名称（默认 deepseek-chat）
 *   DAILY_LIMIT   — 每IP每日免费次数（默认 3）
 */

const fetch = require('node-fetch');

/* ===== 系统提示词（与前端一致，后端注入更安全） ===== */
const SYSTEM_PROMPT = `你是精通传统子平命理的传统文化研究者，只依据《滴天髓》《子平真诠》《穷通宝鉴》《三命通会》《渊海子平》五部典籍做解读。
约束规则：
1、接收用户传入参数：姓名、出生公历年月日时分、性别、出生地、当前大运；优先做真太阳时校正，排定四柱。
2、分析维度固定为：家庭、事业、姻缘、财富、个人特质、健康，共6大模块。
3、输出格式必须为Markdown表格，表格两列：【维度】、【典籍依据核心结论（大白话）】，不要输出第三列典籍出处，典籍逻辑内化到结论，不堆砌原文引文。
4、语言全部大白话，禁用晦涩命理黑话；拒绝无古籍支撑的主观臆断，拒绝迎合讨好、禁止模棱两可套话；只输出命理依据扎实、应象最强、可验证性高的论断。
5、表格结束后增加一段简短流年/大运总评，末尾强制带上提示：【本内容为传统国学文化参考，不作为人生决策唯一依据】。
6、禁止输出多余闲聊、不要反问用户，不要输出排盘过程，直接输出表格+总评。`;

/* ===== 内存级速率限制（冷启动后重置，足够基础防护） ===== */
const rateLimitMap = new Map();

function getTodayKey() {
  // 用 UTC 日期做 key，避免时区差异
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  const realIP = req.headers['x-real-ip'];
  if (realIP) return realIP;
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function getRateLimitState(ip) {
  const today = getTodayKey();
  const state = rateLimitMap.get(ip);
  if (!state || state.date !== today) {
    const newState = { date: today, count: 0 };
    rateLimitMap.set(ip, newState);
    // 简易清理：超过 500 个 IP 时清空旧数据
    if (rateLimitMap.size > 500) rateLimitMap.clear();
    return newState;
  }
  return state;
}

/* ===== 主处理函数 ===== */
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: '仅支持 POST 请求' });
  }

  // 读取环境变量
  const API_BASE  = process.env.LLM_API_BASE  || 'https://api.deepseek.com/v1';
  const API_KEY   = process.env.LLM_API_KEY   || '';
  const MODEL     = process.env.LLM_MODEL     || 'deepseek-chat';
  const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '3', 10);

  if (!API_KEY) {
    return res.status(500).json({
      success: false,
      error: '服务器未配置 LLM_API_KEY 环境变量，请联系管理员',
    });
  }

  // 速率限制检查
  const ip = getClientIP(req);
  const state = getRateLimitState(ip);
  if (state.count >= DAILY_LIMIT) {
    return res.status(429).json({
      success: false,
      error: `今日免费解析次数已用完（每日 ${DAILY_LIMIT} 次），请明天再来`,
      remaining: 0,
    });
  }

  // 解析请求体
  const { message } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ success: false, error: '缺少解析内容' });
  }

  try {
    // 调用 LLM API（OpenAI 兼容格式）
    const apiResponse = await fetch(`${API_BASE.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: message },
        ],
        temperature: 0.7,
        max_tokens: 4096,
      }),
    });

    if (!apiResponse.ok) {
      const errText = await apiResponse.text();
      console.error('LLM API error:', apiResponse.status, errText.substring(0, 500));
      throw new Error(`AI 服务异常（${apiResponse.status}），请稍后重试`);
    }

    const data = await apiResponse.json();
    const content = (
      data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content
    ) || '';
    if (!content) throw new Error('AI 返回内容为空，请重试');

    // 计数 +1
    state.count++;

    return res.status(200).json({
      success: true,
      content,
      remaining: DAILY_LIMIT - state.count,
    });

  } catch (error) {
    console.error('Fortune API error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || '解析过程中出现错误，请重试',
      remaining: DAILY_LIMIT - state.count,
    });
  }
};
