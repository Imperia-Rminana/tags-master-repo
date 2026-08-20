const { ValidateSignature } = require("./signature.cjs");

const CORE_PATTERN =
  /^promotion\/core\/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const BOOSTER_PATTERN =
  /^promotion\/boost\/([a-z0-9][a-z0-9-]*)\/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function IsPromotionPair(headBranch, baseBranch) {
  if (CORE_PATTERN.test(headBranch)) {
    return baseBranch === "production";
  }

  const boosterMatch = BOOSTER_PATTERN.exec(headBranch);
  return Boolean(
    boosterMatch &&
    baseBranch ===
      `boost/${boosterMatch[1]}/${boosterMatch[2]}.${boosterMatch[3]}`,
  );
}

async function HandleWebhook(parameters) {
  const { config, dispatchClient, payload, eventName, deliveryId, signature } =
    parameters;
  if (!ValidateSignature(payload, signature, config.webhookSecret)) {
    return { status: 401 };
  }
  if (eventName !== "pull_request") {
    return { status: 204 };
  }

  const event = JSON.parse(payload.toString("utf8"));
  const pullRequest = event.pull_request;
  if (
    !pullRequest ||
    event.action !== "closed" ||
    pullRequest.merged !== true ||
    !event.repository ||
    event.repository.full_name !== config.parentRepository ||
    !pullRequest.head ||
    !pullRequest.base ||
    !IsPromotionPair(pullRequest.head.ref, pullRequest.base.ref)
  ) {
    return { status: 204 };
  }
  if (
    !Number.isSafeInteger(pullRequest.number) ||
    pullRequest.number < 1 ||
    !deliveryId
  ) {
    throw new SyntaxError("Webhook identity is invalid.");
  }

  await dispatchClient({
    parentRepository: config.parentRepository,
    pullRequestNumber: pullRequest.number,
    deliveryId,
  });
  return { status: 202 };
}

module.exports.HandleWebhook = HandleWebhook;
module.exports.IsPromotionPair = IsPromotionPair;
