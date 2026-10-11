import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const wordPattern = /^[a-z]+(?:['’\-][a-z]+)*['’]?(?:\s+[a-z]+(?:['’\-][a-z]+)*['’]?)*$/i;

function convertVocabulary(data) {
  const entries = Array.isArray(data) ? data : data && typeof data === 'object'
    ? Object.values(data).filter(Array.isArray).flat() : [];
  if (!entries.length) throw new Error('JSON 中没有词条数组。');

  const lines = [];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry?.['单词'] !== 'string' || typeof entry?.['释义'] !== 'string') {
      throw new Error(`第 ${index + 1} 条缺少字符串格式的“单词”或“释义”。`);
    }
    const word = entry['单词'].trim().replace(/\s+/g, ' ');
    const meaning = entry['释义'].trim().replace(/[\t\r\n]+/g, ' ');
    if (!wordPattern.test(word) || !meaning) {
      throw new Error(`第 ${index + 1} 条无法导入：${word || '单词为空'}，请检查单词格式和中文释义。`);
    }
    lines.push(`${word}\t${meaning}`);
  }
  return {
    text: lines.join('\n') + '\n',
    entryCount: entries.length,
    wordCount: lines.length,
  };
}

async function main() {
  const [inputArgument, outputArgument, ...extraArguments] = process.argv.slice(2);
  if (!inputArgument || extraArguments.length) {
    throw new Error('用法：node scripts/convert-vocabulary.mjs <输入 JSON 路径> [输出 TXT 路径]');
  }
  const inputPath = path.resolve(inputArgument);
  const parsedPath = path.parse(inputPath);
  const outputPath = path.resolve(outputArgument ?? path.join(parsedPath.dir, parsedPath.name + '.txt'));
  if (inputPath.toLowerCase() === outputPath.toLowerCase()) throw new Error('输出路径不能与输入 JSON 相同。');
  const source = await readFile(inputPath, 'utf8');
  const result = convertVocabulary(JSON.parse(source.replace(/^\uFEFF/, '')));
  await writeFile(outputPath, result.text, { encoding: 'utf8', flag: 'wx' });
  console.log(`转换完成：${result.entryCount} 条记录 → ${result.wordCount} 个单词。`);
  console.log(`文件：${outputPath}`);
}

main().catch((error) => {
  console.error(error.code === 'EEXIST' ? '输出文件已经存在，请指定另一个 TXT 路径。' : error.message);
  process.exitCode = 1;
});
