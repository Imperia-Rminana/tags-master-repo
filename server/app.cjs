const express = require('express');
const { HandleWebhook } = require('./webhook-handler.cjs');

function CreateApp(parameters)
{
    const { config, dispatchClient } = parameters;
    const app = express();

    app.get('/health', (request, response) =>
    {
        response.status(200).json({ status: 'ok' });
    });

    app.post(
        '/api/github/webhooks/pull-requests',
        express.raw({ type: 'application/json', limit: '1mb' }),
        async (request, response) =>
        {
            try
            {
                const result = await HandleWebhook({
                    config,
                    dispatchClient,
                    payload: request.body,
                    eventName: request.get('X-GitHub-Event') || '',
                    deliveryId: request.get('X-GitHub-Delivery') || '',
                    signature: request.get('X-Hub-Signature-256') || ''
                });
                response.sendStatus(result.status);
            }
            catch (error)
            {
                if (error instanceof SyntaxError)
                {
                    response.sendStatus(400);
                    return;
                }

                response.sendStatus(502);
            }
        }
    );

    app.use((error, request, response, next) =>
    {
        if (error && error.type === 'entity.too.large')
        {
            response.sendStatus(413);
            return;
        }

        next(error);
    });

    return app;
}

module.exports.CreateApp = CreateApp;
