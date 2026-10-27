# 本地生图入口与 DSH 插件

完成时间：2026-10-23

---

## 一、两个入口都做好了

| 入口 | 地址 | 状态 |
|---|---|---|
| **Web 面板「画图」标签页** | http://127.0.0.1:8787 | ✅ 可用 |
| **DSH 工具 `whale_draw`** | DSH 会话里直接调 | ✅ 已注册 |

---

## 二、Web 面板入口

### 位置

控制面板顶部新增第四个标签页 **「画图」**，在「控制台 / 参数配置 / 人设」之后。

### 界面

```
画什么    [多行输入框]
模型      [自动 / SD1.5（快，10 秒）/ SDXL（好，25 秒）]
尺寸      [512 / 768 / 832（SDXL 原生）]
画风      [二次元 / 写实 / 不加约束]
          [生成]  [释放显存]
```

生成后直接显示图片，可点击在新窗口打开原图，并显示实际使用的提示词。

### 实测

```
请求: "画一只可爱的橘猫，简笔画风格"  →  SD1.5 512×512  →  7.1 秒
      "画一只白色的猫，可爱风格"      →  SD1.5 512×512  →  9.1 秒
```

### 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/image/generate` | 生成。`{prompt, model?, size?, style?, seed?, steps?, cfg?, negative?}` |
| GET | `/api/image/file?name=` | 取图（防目录穿越，只允许纯文件名） |
| GET | `/api/image/history` | 最近 30 条生成记录 |
| POST | `/api/image/free` | 释放显存 |
| GET | `/api/image/stats` | 张数与占用 |

**中文提示词会自动翻译成英文 tag**（复用 `translateToPrompt`），英文 tag 直接用。

---

## 三、DSH 插件

### 位置

```
C:\Users\<用户名>\.dsh\profiles\web\dsh-whale-draw\
  index.mjs      插件本体
  package.json
```

挂载在 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-obsidian-bridge
      name: file:///C:/Users/<用户名>/.dsh/profiles/web/dsh-obsidian-bridge/index.mjs
    - id: dsh-whale-draw
      name: file:///C:/Users/<用户名>/.dsh/profiles/web/dsh-whale-draw/index.mjs
```

### 工具定义

```
名称: whale_draw
参数: prompt（必填）、model、size、style
超时: 200 秒
并发: 不安全（显存只能跑一张）
```

调用示例（在 DSH 会话里说）：

> 用 whale_draw 画一只橘猫

模型就会调工具，拿到：

```
已生成 512×512（SD1.5，9.1 秒）
文件：E:\comfyUI\output\whale_00037_.png
预览：http://127.0.0.1:8787/api/image/file?name=whale_00037_.png
实际提示词：masterpiece, best quality, cute, chibi, no humans, cat, white cat, ...
```

### 关键设计决策

**为什么走 HTTP 而不是直接 import whale-chan 的代码？**

| 方案 | 问题 |
|---|---|
| 直接 import | whale-chan 是独立 ESM 项目，路径不在 DSH 模块解析范围 |
| **走 HTTP 调 8787** | ✅ 天然隔离；面板本来就常驻（watchdog 管着）；桥断了不影响 DSH |

**为什么不 import `@deepseek-ai/dsh-tools`？**

profile 的 `node_modules/@deepseek-ai` 里只有 `cosmokit` 和 `schemastery`，
没有 `dsh-tools`。而 `defineTool` 只是把 DSL 转成 JSON Schema 的小工具，
所以**直接给 `tools.register` 传纯 JSON Schema**，零依赖。

**schema 限制**（从 DSH 源码读出来的）：
支持 `type / oneOf / properties / required / additionalProperties / items / enum / const`，
`required` 必须是字符串数组且每个键都在 `properties` 里。

### 验证

用假 ctx 模拟 DSH 调用：

```
插件导出: apply, name
  inject deps: tools
  register 被调用: whale_draw

工具名: whale_draw
参数列表: prompt, model, size, style
出参 schema 类型: object

=== 实际调用 ===
ok: true
filename: whale_00037_.png
model: SD1.5
elapsedMs: 9086
```

**插件逻辑本身是通的**。

---

## 四、当前状态与限制

### 已生效

- ✅ Web 面板「画图」标签页
- ✅ `/api/image/*` 全部接口
- ✅ 插件文件已注册到 profile patch

### 需要重启 DSH 才生效

DSH 的 `patchReload: live` 只对**已加载插件**的配置改动热生效。
**新增 insert 条目需要重启 DSH 进程**才能被 loader 读进去。

所以下次重启 DSH 后，`whale_draw` 工具才会出现在会话里。

### 依赖链

```
DSH 插件
  └─ HTTP → whale-chan 面板 (8787)
       └─ HTTP → ComfyUI (8188)
            └─ GPU (RTX 2070)
```

任何一环挂了，插件会返回明确的错误（"面板未响应" / "ComfyUI 未响应" / "生图未启用"），
不会让 DSH 崩溃。

---

## 五、三个入口的取舍

| 场景 | 用哪个 |
|---|---|
| 想快速试提示词 | **Web 面板**（有输入框，改参数方便） |
| 让 AI 帮你画 | **DSH 工具**（说需求，模型自动翻译 tag） |
| 群里聊天时画 | **QQ 机器人**（说「画个xxx」） |

三者共用同一套 ComfyUI 和模型，只是入口不同。

---

## 六、文件清单

| 文件 | 说明 |
|---|---|
| `src/web/image-api.ts` | 生图 API（生成/取图/历史/释放/统计） |
| `src/web/server.ts` | 挂载 `/api/image/*` 路由 |
| `src/web/config.html` | 「画图」标签页 + 前端逻辑 |
| `~/.dsh/profiles/web/dsh-whale-draw/index.mjs` | DSH 插件本体 |
| `~/.dsh/profiles/web/dsh-whale-draw/package.json` | 插件清单 |
| `~/.dsh/profiles/web/cordis.patch.yml` | 插件挂载（已备份原文件） |
