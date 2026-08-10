import { describe, expect, it } from 'vitest'
import { canonicalizePhone, phoneMatchCandidates } from '../src/phone.js'

describe('telefone canônico (Domain.md: E.164 + 9º dígito)', () => {
  it('normaliza formatos comuns de webhook para E.164', () => {
    expect(canonicalizePhone('5515991230001').e164).toBe('+5515991230001')
    expect(canonicalizePhone('5515991230001@s.whatsapp.net').e164).toBe('+5515991230001')
    expect(canonicalizePhone('+55 (15) 99123-0001').e164).toBe('+5515991230001')
    expect(canonicalizePhone('551533044782').e164).toBe('+551533044782') // fixo, 8 dígitos
  })

  it('preserva o original como veio', () => {
    const r = canonicalizePhone('5515991230001@s.whatsapp.net')
    expect(r.original).toBe('5515991230001@s.whatsapp.net')
  })

  it('candidatos de matching cobrem o 9º dígito nos dois sentidos', () => {
    // móvel BR COM 9: candidato alternativo é SEM o 9
    expect(phoneMatchCandidates('+5515991230001')).toEqual(['+5515991230001', '+551591230001'])
    // móvel BR SEM 9 (8 dígitos começando em 9123): alternativo é COM o 9
    expect(phoneMatchCandidates('+551591230001')).toEqual(['+551591230001', '+5515991230001'])
    // fixo BR: sem alternativo
    expect(phoneMatchCandidates('+551533044782')).toEqual(['+551533044782'])
    // não-BR: sem alternativo
    expect(phoneMatchCandidates('+14155552671')).toEqual(['+14155552671'])
  })

  it('rejeita entrada sem dígitos suficientes', () => {
    expect(() => canonicalizePhone('abc')).toThrow('telefone')
  })

  it('rejeita JID de grupo WhatsApp', () => {
    expect(() => canonicalizePhone('120363025246125437@g.us')).toThrow('grupo/lid')
    expect(() => canonicalizePhone('120363025246125437@G.US')).toThrow('grupo/lid')
  })

  it('rejeita identificador de privacidade @lid', () => {
    expect(() => canonicalizePhone('15551234567@lid')).toThrow('grupo/lid')
    expect(() => canonicalizePhone('15551234567@LID')).toThrow('grupo/lid')
  })

  it('rejeita números com mais de 15 dígitos (teto E.164)', () => {
    expect(() => canonicalizePhone('5515991230001123')).toThrow('telefone') // 16 dígitos
    expect(() => canonicalizePhone('120363025246125437')).toThrow('telefone') // 18 dígitos
  })
})
