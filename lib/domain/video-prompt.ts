export function isChineseVideoPrompt(prompt: string): boolean {
  const han = prompt.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const latin = prompt.match(/[A-Za-z]/g)?.length ?? 0;
  return han >= 10 && han * 5 >= latin;
}
