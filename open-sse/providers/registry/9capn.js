export default {
  id: "9capn",
  priority: 5,
  alias: "9capn",
  display: {
    name: "9Capn",
    icon: "hub",
    color: "#2F80ED",
    textIcon: "9C",
    website: "https://9capn.yogathedev.com",
    notice: {
      text: "Connect to the hosted 9Capn gateway with an API key and route requests through its OpenAI-compatible API.",
      apiKeyUrl: "https://9capn.yogathedev.com/dashboard/api-key",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://9capn.yogathedev.com/v1/chat/completions",
    validateUrl: "https://9capn.yogathedev.com/v1/models",
    thinkingFormat: "openai",
  },
  serviceKinds: ["llm"],
  models: [],
  passthroughModels: true,
  hostedGateway: true,
};
