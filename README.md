# 悦读词 / Yourword

悦读词是一款 AI 语境背单词应用：导入词库，生成包含目标词义的英文阅读材料，在阅读中标记生词，并通过后续文章进行复习。

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
