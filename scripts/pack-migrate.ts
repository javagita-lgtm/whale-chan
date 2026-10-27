/**
 * 迁移打包脚本。
 *
 * 目标：把项目打成一个压缩包，拷到另一台电脑解压后能直接跑起来。
 *
 * 包含：
 *   - 源码（src / test / scripts / config）
 *   - 配置文件（.env，保留密钥；package.json / 锁文件 / tsconfig）
 *   - 已编译的 dist
 *   - 表情包图库（jpg）与 SQLite 数据库
 *   - 启动脚本与迁移说明
 *
 * 排除：
 *   - node_modules（目标机 pnpm install 重装）
 *   - tools（调试 NapCat 时的临时副本，1.5GB，与项目无关）
 *   - data/stickers/raw（转换前的 webp 原图，72MB 冗余）
 *   - 日志、备份文件
 *
 * 用法：pnpm pack:migrate
 */

import { mkdirSync, cpSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * 写批处理文件。
 *
 * Windows 的 cmd 在 chcp 65001 下显示 UTF-8 中文仍可能乱码，
 * 用系统默认的 GBK 编码写入更稳（中文 Windows 都是这个代码页）。
 */
function writeBat(path: string, content: string): void {
  const gbk = Buffer.from(content, 'utf8');
  // 用 PowerShell 转码，避免引入 iconv 依赖
  try {
    const tmp = `${path}.utf8tmp`;
    writeFileSync(tmp, content, 'utf8');
    execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `$c = Get-Content -LiteralPath '${tmp}' -Raw -Encoding UTF8; ` +
        `[IO.File]::WriteAllText('${path}', $c, [Text.Encoding]::GetEncoding(936)); ` +
        `Remove-Item -LiteralPath '${tmp}' -Force`,
    ]);
  } catch {
    // 转码失败就退回 UTF-8（chcp 65001 下大部分情况也能看）
    writeFileSync(path, gbk, 'utf8');
  }
}

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, 'release');
const STAGE = join(OUT_DIR, 'whale-chan');

/** 需要复制的内容（相对路径）。 */
const INCLUDE = [
  'src',
  'test',
  'scripts',
  'config',
  'dist',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'vitest.config.ts',
  '.gitignore',
  '.env',
  '.env.example',
  'README.md',
  'data/whale-chan.sqlite',
  'data/stickers/jpg',
];

/** 需要排除的目录名（复制时跳过）。 */
const EXCLUDE_DIRS = new Set(['node_modules', 'raw', '.git']);

function copyFiltered(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const base = src.split(/[\\/]/).pop() ?? '';
      return !EXCLUDE_DIRS.has(base);
    },
  });
}

function sizeOf(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const out = execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `(Get-ChildItem -LiteralPath '${path}' -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum`,
    ])
      .toString()
      .trim();
    return Number(out) || 0;
  } catch {
    return 0;
  }
}

function main(): void {
  console.log('清理旧的打包目录...');
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });

  console.log('复制文件...');
  let copied = 0;
  for (const item of INCLUDE) {
    const src = join(ROOT, item);
    if (!existsSync(src)) {
      console.log(`  跳过（不存在）：${item}`);
      continue;
    }
    const dest = join(STAGE, item);
    mkdirSync(join(dest, '..'), { recursive: true });
    copyFiltered(src, dest);
    console.log(`  ✓ ${item}`);
    copied++;
  }

  // 启动脚本
  // 注意：必须用 cd /d "%~dp0" 切到自己所在目录。
  // 数据库里存的是相对路径（data/stickers/jpg/xxx.jpg），
  // 如果从别的目录双击启动，工作目录不对就会找不到表情包。
  writeBat(
    join(STAGE, 'start.bat'),
    `@echo off\r\n` +
      `setlocal\r\n` +
      `cd /d "%~dp0"\r\n` +
      `chcp 65001 >nul\r\n` +
      `title Whale-chan\r\n` +
      `echo ================================================\r\n` +
      `echo   Whale-chan 一键启动\r\n` +
      `echo ================================================\r\n` +
      `echo.\r\n` +
      `if not exist node_modules (\r\n` +
      `  echo [1/2] 首次运行，正在安装依赖（需要联网，约 2 分钟）...\r\n` +
      `  call pnpm install\r\n` +
      `  if errorlevel 1 (\r\n` +
      `    echo.\r\n` +
      `    echo [错误] 依赖安装失败。请先安装 Node.js 22+ 和 pnpm。\r\n` +
      `    echo   Node.js: https://nodejs.org/\r\n` +
      `    echo   pnpm:    在命令行运行  npm install -g pnpm\r\n` +
      `    pause\r\n` +
      `    exit /b 1\r\n` +
      `  )\r\n` +
      `)\r\n` +
      `if not exist dist\\index.js (\r\n` +
      `  echo [2/2] 编译中...\r\n` +
      `  call pnpm build\r\n` +
      `)\r\n` +
      `echo.\r\n` +
      `echo 启动机器人... 按 Ctrl+C 退出\r\n` +
      `echo 提示：需要 NapCat 已启动并监听 3001 端口\r\n` +
      `echo.\r\n` +
      `node dist\\index.js\r\n` +
      `echo.\r\n` +
      `echo 机器人已退出。\r\n` +
      `pause\r\n`,
  );

  writeBat(
    join(STAGE, 'start-config.bat'),
    `@echo off\r\n` +
      `setlocal\r\n` +
      `cd /d "%~dp0"\r\n` +
      `chcp 65001 >nul\r\n` +
      `title Whale-chan 配置界面\r\n` +
      `if not exist node_modules (\r\n` +
      `  echo 首次运行，正在安装依赖...\r\n` +
      `  call pnpm install\r\n` +
      `  if errorlevel 1 ( echo [错误] 依赖安装失败 & pause & exit /b 1 )\r\n` +
      `)\r\n` +
      `echo 配置界面：http://127.0.0.1:8787\r\n` +
      `echo 按 Ctrl+C 退出\r\n` +
      `start "" http://127.0.0.1:8787\r\n` +
      `node node_modules\\tsx\\dist\\cli.mjs src/web/index.ts\r\n` +
      `pause\r\n`,
  );

  // 迁移说明
  writeFileSync(join(STAGE, '迁移说明.md'), MIGRATION_DOC, 'utf8');

  console.log('\n统计打包内容...');
  const total = sizeOf(STAGE);
  const jpgCount = existsSync(join(STAGE, 'data/stickers/jpg'))
    ? Number(
        execFileSync('powershell', [
          '-NoProfile',
          '-Command',
          `(Get-ChildItem -LiteralPath '${join(STAGE, 'data/stickers/jpg')}' -File | Measure-Object).Count`,
        ])
          .toString()
          .trim(),
      )
    : 0;

  console.log(`\n打包完成：`);
  console.log(`  目录：${STAGE}`);
  console.log(`  大小：${(total / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  表情包：${jpgCount} 张`);

  // 压缩
  console.log('\n正在压缩为 zip...');
  const zipPath = join(OUT_DIR, `whale-chan-${new Date().toISOString().slice(0, 10)}.zip`);
  if (existsSync(zipPath)) rmSync(zipPath, { force: true });

  try {
    execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${STAGE}' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`,
    ]);
    const zipSize = statSync(zipPath).size;
    console.log(`  压缩包：${zipPath}`);
    console.log(`  大小：${(zipSize / 1024 / 1024).toFixed(1)} MB`);
  } catch (error) {
    console.error(`  压缩失败：${(error as Error).message}`);
    console.log('  可手动压缩目录：' + STAGE);
  }

  console.log('\n完成。把 release/ 下的 zip 拷到新电脑即可。');
}

const MIGRATION_DOC = `# Whale-chan 迁移说明

## 一、新电脑需要先装什么

| 软件 | 版本要求 | 下载 |
|---|---|---|
| Node.js | **22.5 或更高**（用了内置 node:sqlite） | https://nodejs.org/ |
| pnpm | 8+ | 装完 Node 后运行：\`npm install -g pnpm\` |

> 验证：命令行运行 \`node -v\` 和 \`pnpm -v\` 都能输出版本号即可。

## 二、解压后怎么跑

1. 把 zip 解压到任意目录（路径别带中文和特殊符号更稳妥）
2. 双击 **start.bat**
   - 首次运行会自动安装依赖（需要联网，约 2 分钟）
   - 然后自动启动机器人

启动成功的标志：

\`\`\`
{"level":"info","scope":"memory","msg":"记忆库已就绪"}
{"level":"info","scope":"main","msg":"表情包图库已加载","data":{"count":1218}}
{"level":"info","scope":"onebot","msg":"已连接 OneBot v11"}
{"level":"info","scope":"main","msg":"登录身份确认"}
\`\`\`

如果卡在 \`将在 xxx ms 后重连\` 且反复重试，说明 **NapCat 没启动**，见下一节。

## 三、NapCat（QQ 协议端）要单独装

**打包里没有包含 NapCat**，因为它有 1.2GB 且与具体 QQ 版本强绑定，必须在新机器上单独部署。

1. 去 https://github.com/NapNeko/NapCatQQ/releases 下载
   \`NapCat.Shell.Windows.OneKey.zip\`（一键包）
2. 解压后运行，按提示扫码登录小号
3. 在 NapCat 的 WebUI（默认 http://127.0.0.1:6099）里配置：
   - 新增 **WebSocket 服务器**（正向 WS）
   - 端口填 **3001**
   - 消息格式选 **array**
   - Token 留空（与 .env 里 ONEBOT_ACCESS_TOKEN 一致即可）
4. 保存启用，再运行 start.bat

> 或者直接双击包里的 start.bat，机器人会自动重连，等 NapCat 起来就自动连上。

## 四、当前配置（已随包携带）

| 项目 | 值 |
|---|---|
| 模型 | deepseek-flash |
| 机器人 QQ | 见 .env 的 BOT_SELF_ID |
| 人设 | 鲸鱼酱（闲聊 120 字 / 技术 300 字） |
| 表情包 | 1218 张，已入库 |
| 主动插话 | 已开启，限指定群 |
| 图片识别 | 已开启 |

API Key 等密钥已包含在 \`.env\` 里，**开箱即用，不用重新填**。

## 五、修改配置

双击 **start-config.bat**，会自动打开浏览器配置界面：

- 参数配置：33 项，带校验
- 人设：可视化编辑

> 也可以直接改 \`.env\` 和 \`config/persona.json\`。

## 六、常用命令

\`\`\`powershell
pnpm start          # 启动机器人
pnpm config         # 打开配置界面
pnpm test           # 跑测试（115 个）
pnpm stickers:fetch # 补全表情包图库
pnpm stickers:search 好累   # 搜索表情包
\`\`\`

## 七、注意事项

- **机器人和 NapCat 必须同时运行**才能收发 QQ 消息
- 机器人进程关掉，QQ 群里就没反应了（但消息不会丢，重启后不会补发）
- NapCat 掉线需要重新扫码登录，这是腾讯风控的常态
- \`.env\` 里有明文密钥，**别把包发给别人**
- 表情包是网友二创，仅供个人使用

## 八、如果出问题

| 现象 | 原因 | 解决 |
|---|---|---|
| 反复重连 | NapCat 没起 / 端口不对 | 确认 NapCat 的 WS 端口是 3001 |
| 连上了但不回复 | 没 @ / 或模型 Key 失效 | 在群里 @ 它；检查 .env 的 LLM_API_KEY |
| 回复为空 | token 上限太小 | 配置界面把 LLM_MAX_TOKENS 调到 2048 |
| 发图失败 | 图片路径问题 | 确认 data/stickers/jpg 存在且非空 |
`;

main();
