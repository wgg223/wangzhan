const { app } = require('nitron')

app.init({
  name: "浮沉",
  packageId: "com.dalaowang.app",
  version: "1.0.0",
  entry: "index.html",
  orientation: "portrait",
  statusBar: true,
  permissions: ["INTERNET", "ACCESS_NETWORK_STATE"],
  icon: {
    src: "./icon.png",
    background: "#6366f1"
  }
})
