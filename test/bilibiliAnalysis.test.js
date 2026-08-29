const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseAnalysisContent,
  normalizeAnalysis,
  formatAnalysisMarkdown,
  normalizeQuestionHistory,
  sampleTranscript,
} = require("../services/bilibiliAnalysisService");

test("repairs unescaped quotes in structured analysis content", () => {
  const result = parseAnalysisContent(
    '{"summary":"涨了称"带粉丝吃肉"、跌了改口"高低切"。","chapters":[{"time":"1.0s","title":"博主"神化"现象","summary":"不要盲目跟随"老师"。"}],"keyPoints":["先做"预期""],"quotes":[],"todos":[]}',
  );
  assert.equal(
    result.summary,
    "涨了称「带粉丝吃肉」、跌了改口「高低切」。",
  );
  assert.equal(result.chapters[0].title, "博主「神化」现象");
  assert.equal(result.keyPoints[0], "先做「预期」");
});

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

test("samples long transcripts across beginning, middle and end", () => {
  const transcript = `${"A".repeat(120)}${"B".repeat(120)}${"C".repeat(120)}`;
  const sampled = sampleTranscript(transcript, 90);
  assert.match(sampled, /【字幕开头】/);
  assert.match(sampled, /【字幕中段】/);
  assert.match(sampled, /【字幕结尾】/);
  assert.match(sampled, /A+/);
  assert.match(sampled, /B+/);
  assert.match(sampled, /C+/);
});

test("bounds and cleans transcript question history", () => {
  const history = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: ` message-${index} `,
  }));
  history.push({ role: "system", content: "ignore" });
  const normalized = normalizeQuestionHistory(history);
  assert.equal(normalized.length, 7);
  assert.equal(normalized[0].content, "message-3");
  assert.equal(normalized.at(-1).content, "message-9");
});
