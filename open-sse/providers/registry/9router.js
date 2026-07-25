export default {
  id: "9router",
  priority: 5,
  alias: "9router",
  display: {
    name: "9Router",
    icon: "hub",
    color: "#E56A4A",
    textIcon: "9R",
    website: "https://9router.yogathedev.com",
    notice: {
      text: "Connect to the hosted 9Router gateway with an API key and route requests through its OpenAI-compatible API.",
      apiKeyUrl: "https://9router.yogathedev.com/dashboard/api-key",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://9router.yogathedev.com/v1/chat/completions",
    validateUrl: "https://9router.yogathedev.com/v1/models",
    thinkingFormat: "openai",
  },
  serviceKinds: ["llm"],
  models: [],
  passthroughModels: true,
};
