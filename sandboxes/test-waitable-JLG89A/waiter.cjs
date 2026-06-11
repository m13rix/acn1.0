exports.ask = async function ask(question) {
  await new Promise(resolve => setTimeout(resolve, 80));
  console.log("answered " + question);
  return "ok";
};