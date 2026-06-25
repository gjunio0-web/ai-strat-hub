exports.handler = async function(event, context) {
    // 1. Bloqueio de métodos não autorizados
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const body = JSON.parse(event.body);
        
        // 2. Leitura da credencial do cofre do Netlify
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) {
            return {
                statusCode: 500,
                body: JSON.stringify({ error: "Erro Crítico: Chave de API não configurada no cofre do Netlify." })
            };
        }

        // 3. Comunicação isolada e segura com o Google (Modelo Estável e Atualizado)
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        const data = await response.json();

        // 4. Retorno do pacote para a SPA
        return {
            statusCode: response.status,
            body: JSON.stringify(data)
        };
        
    } catch (error) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};