/**
 * 로컬 LLM(Ollama) 채팅 판정·요약 — 채팅 모더레이터(실험 기능) 전용
 *
 * judge(): 최근 대화 6줄 중 마지막 줄이 성적/자해/폭력/혐오 위반인지 판정 (짧은 JSON만 받아 빠르게)
 * summarize(): 로그용 요약 — 원문 인용 없이 대화 흐름만. 조치·알림 대상일 때만 호출한다.
 *
 * 모델 기본값 exaone3.5:7.8b — i7-8700 CPU 실측 판정 중앙값 약 4초.
 * 한국어 54문장 실측에서 confidence 0.9 이상만 조치하면 무고한 조치 0건 (오탐은 0.8로 나옴).
 * Ollama가 없거나 오류면 null 을 반환해 아무 조치도 하지 않는다.
 */
const config = require('../config');
const logger = require('../utils/logger');

const CATEGORIES = ['sexual', 'self_harm', 'violence', 'hate'];

const JUDGE_PROMPT = `너는 한국어 디스코드 채팅 모더레이터다. 최근 대화 흐름을 참고해 [판정 대상] 한 줄만 판정한다.
위반 분류:
- sexual: 음란물 공유·판매·요청, 성적 행위 제안, 노골적 성적 묘사
- self_harm: 실제 자살·자해 의도, 계획, 방법 문의, 작별 암시
- violence: 특정인에게 실제로 해를 가하겠다는 위협
- hate: 성별·장애·지역·인종 등 집단 혐오, 특정인을 향한 심한 인신공격
- none: 위반 아님
한국어 은어 풀이: ㅂㅈ·보징어=여성 성기, ㅈㅈ·꼬추=남성 성기, 딸·딸딸이·ㄸㄸㅇ=자위, 야동·ㅇㄷ·노모·국산=음란 영상, 몸캠·영통=노출 영상통화, 조건·ㅈㄱ=성매매, 섹·ㅅㅅ=성관계, 패다·조지다=때리다.
연인·지인과의 성관계 영상·사진을 보여주겠다·팔겠다는 말은 sexual 이다. 특정인을 실제로 때리러·찾아가겠다는 예고는 violence 이다.
위반이 아닌 것(none): "배고파 죽겠다", "졸려 죽겠다", "과제 때문에 죽고싶다 ㅋㅋ" 같은 과장 표현 / 게임 속 캐릭터나 상대팀을 "죽인다"는 말 / 영화·뉴스·과제·예방 캠페인 언급 / 우울하다·힘들다는 하소연만 있는 경우 / 친구끼리 가벼운 욕설·장난.
확실할 때만 위반으로 판정한다. JSON 으로만 답한다: {"category":"sexual|self_harm|violence|hate|none","confidence":0.0~1.0}`;

const SUMMARY_PROMPT = {
  ko: '너는 디스코드 관리자용 로그를 쓴다. 대화의 마지막 줄이 [{cat}] 위반으로 판정되었다. ' +
    '그 전까지의 대화 흐름과, 마지막 줄을 누가 어떤 내용으로 보냈는지를 2~3문장 한국어로 요약한다. ' +
    '원문을 그대로 인용하지 말고, 욕설·성적 표현은 순화해서 무슨 일이 있었는지만 적는다. 요약 문장만 출력한다.',
  en: 'You write logs for Discord moderators. The last line of the chat was flagged as [{cat}]. ' +
    'Summarize in 2-3 English sentences the flow leading up to it and who sent the last line and what it was about. ' +
    'Do not quote the original text; paraphrase slurs or sexual wording and describe only what happened. Output the summary only.',
};
const CATEGORY_LABEL = {
  ko: { sexual: '성적', self_harm: '자살·자해', violence: '폭력 위협', hate: '혐오·모욕' },
  en: { sexual: 'sexual/NSFW', self_harm: 'suicide/self-harm', violence: 'threat of violence', hate: 'hate/severe insult' },
};

async function chat(messages, { format, numPredict, timeoutMs }) {
  const res = await fetch(`${config.OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.CHAT_MOD_MODEL,
      messages,
      stream: false,
      keep_alive: -1, // 상주 — 매 메시지마다 모델 재로딩 방지
      ...(format ? { format } : {}),
      // 판정 대상은 잘라내지 않으므로(디스코드 최대 4000자) 넉넉히. 판정·요약이 같은 값이어야 모델을 다시 올리지 않는다
      options: { temperature: 0, num_ctx: 8192, num_predict: numPredict },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.message?.content || '';
}

/**
 * @param {string[]} lines "이름: 내용" 형식, 마지막 줄이 판정 대상 (최대 6줄)
 * @returns {Promise<{category:string, confidence:number}|null>} 오류 시 null
 */
async function judge(lines) {
  const last = lines[lines.length - 1];
  const user = `[최근 대화]\n${lines.join('\n')}\n\n[판정 대상]\n${last}`;
  try {
    const raw = await chat(
      [{ role: 'system', content: JUDGE_PROMPT }, { role: 'user', content: user }],
      { format: 'json', numPredict: 40, timeoutMs: 60000 },
    );
    const o = JSON.parse(raw);
    return {
      category: CATEGORIES.includes(o.category) ? o.category : 'none',
      confidence: Math.min(1, Math.max(0, Number(o.confidence) || 0)),
    };
  } catch (e) {
    logger.warn('채팅 판정 LLM 호출 실패', { error: e.message });
    return null;
  }
}

/**
 * @param {string[]} lines 요약할 대화 (판정에 쓴 6줄, 마지막 줄이 판정 대상)
 * @param {string} category judge() 가 낸 분류
 * @param {string} lang 'ko' | 'en'
 * @returns {Promise<string|null>} 오류 시 null
 */
async function summarize(lines, category, lang) {
  const L = SUMMARY_PROMPT[lang] ? lang : 'en';
  const prompt = SUMMARY_PROMPT[L].replace('{cat}', CATEGORY_LABEL[L][category] || category);
  try {
    const text = await chat(
      // 대화가 한국어면 지시와 무관하게 한국어로 답하는 경향이 있어 끝에 출력 언어를 다시 못박는다
      [{ role: 'system', content: prompt }, { role: 'user', content: `${lines.join('\n')}\n\n${L === 'ko' ? '(한국어로 요약)' : '(Write the summary in English.)'}` }],
      { numPredict: 200, timeoutMs: 120000 },
    );
    return text.trim() || null;
  } catch (e) {
    logger.warn('채팅 요약 LLM 호출 실패', { error: e.message });
    return null;
  }
}

module.exports = { judge, summarize, CATEGORIES };
