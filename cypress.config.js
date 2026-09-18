const { defineConfig } = require("cypress");

module.exports = defineConfig({
    e2e: {
        baseUrl: 'http://localhost:8080',
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
