import { DOC_VERSION, type Block, type BlockType, type ButtonAction, type FormField, type PageDocument, type SuccessAction } from './schema.js';

/** Factory for blocks with sequential ids. Used by templates, the AI generator, the default page and the web palette. */
export function createBuilder(prefix = 'b') {
  let n = 0;
  const id = () => `${prefix}${++n}`;
  const nextStep: ButtonAction = { type: 'next_step' };
  return {
    id,
    section: (children: Block[], o: { background?: string; padding?: 'none' | 'sm' | 'md' | 'lg' | 'xl'; width?: 'narrow' | 'medium' | 'wide' | 'full'; align?: 'left' | 'center'; anchor?: string } = {}): Block => ({
      id: id(), type: 'section', padding: 'md', width: 'medium', align: 'left', ...o, children,
    }),
    columns: (cols: Block[][], o: { gap?: 'sm' | 'md' | 'lg' } = {}): Block => ({
      id: id(), type: 'columns', gap: o.gap ?? 'md', columns: cols.map((children) => ({ id: id(), children })),
    }),
    heading: (text: string, o: { level?: number; align?: 'left' | 'center' | 'right'; color?: string } = {}): Block => ({ id: id(), type: 'heading', text, level: o.level ?? 2, ...(o.align ? { align: o.align } : {}), ...(o.color ? { color: o.color } : {}) }),
    paragraph: (text: string, o: { align?: 'left' | 'center' | 'right'; color?: string } = {}): Block => ({ id: id(), type: 'paragraph', text, ...o }),
    image: (src: string, alt: string, o: { width?: number; align?: 'left' | 'center' | 'right' } = {}): Block => ({ id: id(), type: 'image', src, alt, ...o }),
    button: (text: string, action: ButtonAction = nextStep, o: { style?: 'primary' | 'secondary' | 'outline'; size?: 'sm' | 'md' | 'lg'; align?: 'left' | 'center' | 'right'; fullWidth?: boolean } = {}): Block => ({
      id: id(), type: 'button', text, action, style: o.style ?? 'primary', size: o.size ?? 'md', ...(o.align ? { align: o.align } : {}), ...(o.fullWidth ? { fullWidth: true } : {}),
    }),
    video: (url: string, title = 'Video'): Block => ({ id: id(), type: 'video', url, title }),
    divider: (): Block => ({ id: id(), type: 'divider' }),
    spacer: (height = 32): Block => ({ id: id(), type: 'spacer', height }),
    list: (items: string[], o: { ordered?: boolean; icon?: 'check' | 'dot' } = {}): Block => ({ id: id(), type: 'list', items, icon: o.icon ?? 'check', ...(o.ordered ? { ordered: true } : {}) }),
    faq: (items: { q: string; a: string }[]): Block => ({ id: id(), type: 'faq', items }),
    countdown: (o: { mode: 'fixed' | 'evergreen'; endsAt?: string; minutes?: number; label?: string }): Block => ({ id: id(), type: 'countdown', expiredText: 'This offer has ended', ...o }),
    form: (o: { name?: string; fields: FormField[]; submitLabel?: string; consent?: boolean; success?: SuccessAction }): Block => ({
      id: id(), type: 'form', name: o.name ?? 'Form', fields: o.fields, submitLabel: o.submitLabel ?? 'Submit',
      consent: { enabled: o.consent ?? false, text: 'I agree to receive emails and can unsubscribe at any time.' }, success: o.success ?? { type: 'next_step' },
    }),
    checkout: (o: { productName: string; price: number; currency?: string; description?: string; buttonLabel?: string; orderBump?: boolean; oneClickUpsell?: boolean; success?: SuccessAction }): Block => ({
      id: id(), type: 'checkout', currency: 'USD', buttonLabel: 'Buy now', orderBump: false, oneClickUpsell: false, success: { type: 'next_step' }, ...o,
    }),
    html: (html: string): Block => ({ id: id(), type: 'html', html }),
  };
}

export const field = (id: string, type: FormField['type'], label: string, required = false, extra: Partial<FormField> = {}): FormField => ({ id, type, label, required, ...extra });

export function documentOf(blocks: Block[], settings: Partial<PageDocument['settings']> = {}): PageDocument {
  return { version: DOC_VERSION, settings: { font: 'system', ...settings }, blocks };
}

export function emptyDocument(): PageDocument {
  return documentOf([]);
}

export function defaultStepDocument(headline = 'Your headline goes here'): PageDocument {
  const b = createBuilder('d');
  return documentOf([
    b.section(
      [
        b.heading(headline, { level: 1, align: 'center' }),
        b.paragraph('Tell visitors what they get and why it matters. Click any block to edit it.', { align: 'center', color: '#4b5563' }),
        b.button('Continue', { type: 'next_step' }, { size: 'lg', align: 'center' }),
      ],
      { padding: 'lg', align: 'center' },
    ),
  ]);
}

/** A fresh block of the given type, as dropped from the web builder palette. */
export function newBlock(type: BlockType, id: string): Block {
  const b = createBuilder(id + '-');
  const withId = (x: Block): Block => ({ ...x, id }) as Block;
  switch (type) {
    case 'section': return withId(b.section([]));
    case 'columns': return withId(b.columns([[], []]));
    case 'heading': return withId(b.heading('New heading'));
    case 'paragraph': return withId(b.paragraph('Write something compelling here.'));
    case 'image': return withId(b.image('https://placehold.co/800x400', 'Describe the image'));
    case 'button': return withId(b.button('Click here'));
    case 'video': return withId(b.video('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));
    case 'divider': return withId(b.divider());
    case 'spacer': return withId(b.spacer());
    case 'list': return withId(b.list(['First benefit', 'Second benefit', 'Third benefit']));
    case 'faq': return withId(b.faq([{ q: 'A common question?', a: 'A clear answer.' }]));
    case 'countdown': return withId(b.countdown({ mode: 'evergreen', minutes: 30, label: 'Offer ends in' }));
    case 'form':
      return withId(b.form({ name: 'Opt-in form', fields: [field('name', 'name', 'Name', true), field('email', 'email', 'Email', true)], submitLabel: 'Get access', consent: false }));
    case 'checkout': return withId(b.checkout({ productName: 'My product', price: 49, description: 'What the buyer gets.' }));
    case 'html': return withId(b.html('<p>Custom HTML</p>'));
  }
}
