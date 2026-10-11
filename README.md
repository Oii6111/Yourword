# 悦读词 / Yourword

悦读词是一款 AI 语境背单词应用：导入词库，让每个词义都进入英文阅读材料，在真实变化的语境中记住单词。

## 核心特点

1. **一个词的多个意思，分别进入语境**：同一个单词的不同词义会被独立覆盖，帮助你真正记住一词多意。
2. **摆脱固定例句**：传统例句背熟后，换一个句子可能仍然认不出来；悦读词持续生成新的文章和表达，让你适应不同语境中的实际用法。
3. **按轮次递进复习**：第一轮阅读后标记不认识的词义，第二轮只用这些词义生成全新的文章；每轮不断缩小范围，同时培养词汇的理解和应用能力。

## 功能

- 导入 UTF-8、GB18030/GBK 编码的 TXT 词库
- 按词性和词义管理多义词
- 按单词快速筛选生词并创建分支词库
- 生成英文文章、句组或段落练习目标词义
- 点击单词查看当前语境释义并标记生词
- 首次覆盖后，只复习上一轮标记的词义
- 后端保存词库、文章、进度和 API 配置

## 启动

需要 Node.js 20.19+ 或 22.12+。

```bash
npm install
npm run dev
```

打开 <http://127.0.0.1:5173/>，在“连接设置”中填写兼容 OpenAI Chat Completions 的 Base URL、API Key 和模型名。

## 词库格式

每行使用“单词 + Tab + 中文释义”：

```text
bank	n. 银行；岸
revolt	n. 反抗；造反，起义 v. 起义；反抗
curious	adj. 好奇的
```

JSON 词库可使用转换脚本：

```bash
node scripts/convert-vocabulary.mjs input.json output.txt
```

推荐词库来源：[KyleBing/english-vocabulary](https://github.com/KyleBing/english-vocabulary/tree/master)

## 数据存储

词库、文章、筛选记录、学习进度和导入草稿保存在本机 `data/` 目录；API Key 仅由本机后端保存。`data/` 已加入 Git 忽略，请自行备份。

## 测试

```bash
npm test
npm run test:server
npm run build
npm run test:e2e
```
