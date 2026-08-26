const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeAnalysis,
  formatAnalysisMarkdown,
} = require("../services/bilibiliAnalysisService");

test("normalizes bounded subtitle analysis output", () => {
  const result = normalizeAnalysis({
    summary: "  摘要  ",
    chapters: [{ time: "[1.0s]", title: "开场", summary: "介绍" }],
    keyPoints: ["观点一", null],
    quotes: [{ time: "2.0s", text: "金句" }],
    todos: ["执行事项"],
  });
  assert.deepEqual(result, {
    summary: "摘要",
    chapters: [{ time: "[1.0s]", title: "开场", summary: "介绍" }],
    keyPoints: ["观点一"],
    quotes: [{ time: "2.0s", text: "金句" }],
    todos: ["执行事项"],
  });
});

test("formats analysis as exportable Markdown", () => {
  const markdown = formatAnalysisMarkdown(
    "测试视频",
    normalizeAnalysis({
      summary: "摘要",
      chapters: [{ time: "1.0s", title: "章节", summary: "内容" }],
      keyPoints: ["观点"],
      quotes: [{ time: "2.0s", text: "原话" }],
      todos: ["行动"],
    }),
  );
  assert.match(markdown, /^# 测试视频/);
  assert.match(markdown, /## 章节/);
  assert.match(markdown, /- \[ \] 行动/);
});
