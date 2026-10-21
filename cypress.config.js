const { defineConfig } = require("cypress");

module.exports = defineConfig({
    e2e: {
        baseUrl: 'http://localhost:8080',
        viewportWidth: 1920,
        viewportHeight: 1080,
        setupNodeEvents(on, config) {
            on('task', {
                log(message) {
                    console.log('[CY TASK LOG]', message);
                    return null;
                }
            });
        },
        supportFile: false,
    },
});
