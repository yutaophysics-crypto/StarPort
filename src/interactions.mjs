export function validateReply(store,chatId,replyTo){
  if(replyTo==null)return null;
  if(typeof replyTo!=='object'||Array.isArray(replyTo)||typeof replyTo.messageId!=='string'||!Array.isArray(replyTo.questions)||!replyTo.questions.length||replyTo.questions.length>8||replyTo.questions.some(id=>typeof id!=='string'||!/^[-\w:]{1,120}$/.test(id)))throw new Error('问题回答关联无效');
  if(store.messageById(chatId,replyTo.messageId)?.role!=='assistant')throw new Error('问题已失效，请重新打开对话');
  return {messageId:replyTo.messageId,questions:[...new Set(replyTo.questions)]};
}
export const MAX_INPUT_CHARS = 100000;
export function validateInput(text){
  if(typeof text!=='string'||!text.trim()||text.length>MAX_INPUT_CHARS)throw new Error(`请输入 1–${MAX_INPUT_CHARS} 字符的消息`);
  return text;
}
