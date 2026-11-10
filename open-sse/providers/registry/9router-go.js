export default {
  id: "9router-go",
  priority: 5,
  alias: "9router-go",
  display: {
    name: "9Router Go",
    icon: "hub",
    color: "#00ADD8",
    textIcon: "9G",
    website: "https://9router-go.yogathedev.com",
    notice: {
      text: "Connect to the hosted 9Router Go gateway with an API key and route requests through its OpenAI-compatible API.",
      apiKeyUrl: "https://9router-go.yogathedev.com/dashboard/api-key",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://9router-go.yogathedev.com/v1/chat/completions",
    validateUrl: "https://9router-go.yogathedev.com/v1/models",
    thinkingFormat: "openai",
  },
  serviceKinds: ["llm"],
  models: [],
  passthroughModels: true,
  hostedGateway: true,
};
