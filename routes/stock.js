'use strict'

const express = require('express')
const router = express.Router()
const { getRecommendations, analyzeMarketEnv } = require('../services/stock/recommend')
const { getAshareList } = require('../services/stock/data')

// 短线荐股主接口
// 查询参数：
//   limit    候选扫描上限（默认 0 = 不限制，对全主板非 ST 逐只分析；可传大数如 5000 限制只数）
//   refresh=1 强制刷新当日缓存
router.get('/recommend', async (req, res) => {
  try {
    const rawLimit = req.query.limit
    const limit = rawLimit === undefined ? 0 : Math.min(Math.max(0, parseInt(rawLimit, 10) || 0), 8000)
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true'
    const data = await getRecommendations({ limit, refresh })
    res.json({ success: true, data })
  } catch (e) {
    const cause = e.cause ? ` | cause: ${e.cause.code || e.cause.message}` : ''
    console.error('[stock/recommend] 失败:', e.message + cause)
    res.status(500).json({ success: false, error: (e.message + cause) || '荐股计算失败' })
  }
})

// 仅市场环境概览
router.get('/market-env', async (req, res) => {
  try {
    const list = await getAshareList()
    const data = analyzeMarketEnv(list)
    res.json({ success: true, data })
  } catch (e) {
    console.error('[stock/market-env] 失败:', e.message)
    res.status(500).json({ success: false, error: e.message || '市场环境计算失败' })
  }
})

module.exports = router
