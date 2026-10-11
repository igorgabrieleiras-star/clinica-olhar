// Dados enviados à Meta: nada de saúde, idade, nome de procedimento ou parâmetros de URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { buildLeadPayload, cleanSourceUrl } = await import('../src/meta.js');

const booking = { name: 'Maria Teste', whatsapp: '92981112233', patientId: 7, eventId: '11111111-2222-3333-4444-555555555555', age: '67' };

test('Lead pela API de Conversões: só dados permitidos, mesmo event_id do navegador', () => {
  const p = buildLeadPayload({
    booking, eventName: 'Lead',
    ctx: { ip: '1.2.3.4', userAgent: 'UA', landingPage: 'https://site.exemplo/?utm_campaign=catarata&fbclid=abc#x' },
  });
  const ev = p.data[0];
  assert.equal(ev.event_name, 'Lead');
  assert.equal(ev.event_id, booking.eventId);
  assert.equal(ev.action_source, 'website');
  assert.equal(ev.event_source_url, 'https://site.exemplo/', 'sem parâmetros de URL');
  assert.equal(ev.custom_data, undefined, 'sem parâmetros personalizados');
  const raw = JSON.stringify(p);
  assert.doesNotMatch(raw, /67|Maria|92981112233|catarata|exame|vista/i, 'sem idade, nome, telefone em claro ou termos de saúde');
  assert.equal(p.test_event_code, undefined);
});

test('URL de origem inválida ou não http é descartada', () => {
  assert.equal(cleanSourceUrl('javascript:alert(1)'), undefined);
  assert.equal(cleanSourceUrl('nada'), undefined);
  assert.equal(cleanSourceUrl(undefined), undefined);
});

test('Pixel do navegador: eventos sem parâmetros de conteúdo', () => {
  const js = readFileSync(new URL('../public/assets/site.js', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /content_name|content_category/);
  assert.match(js, /track\('track', 'Lead', \{\}, b\.eventId\)/, 'Lead com o event_id do agendamento');
});
