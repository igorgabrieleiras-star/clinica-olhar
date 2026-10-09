// Modelo inicial da Política de Privacidade. Deve ser revisado pela clínica e por sua assessoria jurídica.
// Marcadores {{...}} são substituídos pelos dados configurados no painel.
// Formato: linhas iniciadas com "## " viram subtítulos; linhas em branco separam parágrafos; "- " vira item de lista.

export const DEFAULT_PRIVACY_POLICY = `Esta política explica como a {{clinica}} trata os dados pessoais informados no agendamento do exame de vista gratuito, conforme a Lei Geral de Proteção de Dados (Lei nº 13.709/2018).

## Quais dados coletamos
- Nome e idade da pessoa que fará o exame.
- Número de WhatsApp para contato.
- Nome do responsável, quando o paciente é menor de idade.
- Data e horário escolhidos e o número de protocolo.
- Informações técnicas da visita, como a página de origem e parâmetros de campanha (UTM), usadas para entender de onde vêm os agendamentos.

Não pedimos CPF, e-mail, endereço residencial nem informações de saúde neste formulário.

## Para que usamos
- Organizar e confirmar o seu atendimento.
- Entrar em contato pelo WhatsApp sobre o agendamento (confirmação, lembrete, remarcação ou cancelamento).
- Enviar mensagens promocionais, somente se você autorizar. Essa autorização é opcional e pode ser retirada a qualquer momento.
- Exibir o seu primeiro nome no aviso de agendamentos recentes do site, somente se você autorizar.
- Medir o desempenho dos nossos anúncios, somente se você aceitar os cookies de medição.

## Com quem compartilhamos
Os dados ficam armazenados em servidores contratados pela clínica. Quando você aceita os cookies de medição, informações técnicas e o número de WhatsApp em formato criptografado (hash) podem ser enviados à Meta (Facebook e Instagram) para medir os resultados dos anúncios. Nunca enviamos informações clínicas ou resultados de exames para plataformas de publicidade.

## Por quanto tempo guardamos
Os dados do agendamento são mantidos por até {{retencao}} dias após a data do atendimento e depois anonimizados, salvo quando a lei exigir prazo maior.

## Seus direitos
Você pode pedir a confirmação, o acesso, a correção ou a exclusão dos seus dados, além de retirar autorizações dadas. Para isso, fale com a clínica pelo WhatsApp {{whatsapp}} informando o seu protocolo.

## Atualizações
Esta política pode ser atualizada. A versão em vigor é sempre a publicada nesta página.`;

export function renderLegal(body, vars) {
  const filled = body.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] !== undefined && vars[k] !== '' ? vars[k] : '[a definir]'));
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const blocks = filled.split(/\n\s*\n/);
  return blocks
    .map((block) => {
      const lines = block.split('\n');
      const out = [];
      let list = [];
      const flush = () => {
        if (list.length) out.push('<ul>' + list.map((l) => `<li>${esc(l)}</li>`).join('') + '</ul>');
        list = [];
      };
      for (const line of lines) {
        if (line.startsWith('## ')) { flush(); out.push(`<h2>${esc(line.slice(3))}</h2>`); }
        else if (line.startsWith('- ')) list.push(line.slice(2));
        else if (line.trim()) { flush(); out.push(`<p>${esc(line)}</p>`); }
      }
      flush();
      return out.join('');
    })
    .join('\n');
}
