/** 终端交互选择：方向键移动、回车确认。无第三方依赖，只用 ANSI 控制符重绘。 */
const readline = require("node:readline");

const CLEAR_LINE = "\x1b[2K";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

function moveIndex(current, delta, length) {
  return (current + delta + length) % length;
}

function optionLines(options, index) {
  return options.map((option, i) => {
    const active = i === index;
    const cursor = active ? `${CYAN}❯${RESET}` : " ";
    const label = active ? `${CYAN}${option.label}${RESET}` : option.label;
    const hint = option.hint ? `  ${DIM}${option.hint}${RESET}` : "";
    return `${cursor} ${label}${hint}`;
  });
}

function selectOption({
  message,
  options,
  input = process.stdin,
  output = process.stdout,
}) {
  return new Promise((resolve) => {
    readline.emitKeypressEvents(input);
    const previousRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();

    let index = 0;
    let printed = 0;

    function paint(final = false) {
      if (printed > 0) output.write(`\x1b[${printed}A`);
      const rows = final
        ? [`${GREEN}✔${RESET} ${options[index].label}`]
        : [message, ...optionLines(options, index)];
      for (const row of rows) output.write(`${CLEAR_LINE}${row}\n`);
      // 确认后收起剩余行，避免终端里留下选项残影
      for (let i = rows.length; i < printed; i += 1) output.write(`${CLEAR_LINE}\n`);
      printed = final ? 0 : rows.length;
    }

    function cleanup() {
      input.removeListener("keypress", onKeypress);
      input.setRawMode(Boolean(previousRaw));
      input.pause();
    }

    function onKeypress(str, key = {}) {
      if (key.ctrl && key.name === "c") {
        cleanup();
        output.write("\n");
        process.exit(130);
      }
      if (key.name === "up" || str === "k") {
        index = moveIndex(index, -1, options.length);
        paint();
        return;
      }
      if (key.name === "down" || str === "j") {
        index = moveIndex(index, 1, options.length);
        paint();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        paint(true);
        resolve(options[index]);
      }
    }

    input.on("keypress", onKeypress);
    paint();
  });
}

module.exports = { moveIndex, optionLines, selectOption };
