import { useEffect } from 'react'
import { useOutletContext } from 'react-router'
import type { SiteContact } from '@/domain/site'

/** Sets the browser tab title while the page is open. */
export function useTitle(title: string) {
  useEffect(() => {
    const before = document.title
    document.title = title
    return () => {
      document.title = before
    }
  }, [title])
}

/** What the site frame hands its pages: a ref for the dark hero the header turns transparent over. */
export interface SiteFrame {
  heroRef: (el: HTMLElement | null) => void
}

/** Put on a page's full-bleed photo hero; the header stays transparent until the hero scrolls away. */
export const useHeroRef = () => useOutletContext<SiteFrame>().heroRef

/** The operator's WhatsApp and email, or placeholders that say they are placeholders. */
export function contactLines(contact: SiteContact | undefined) {
  const whatsapp = contact?.whatsapp ?? null
  const email = contact?.email ?? null
  return {
    whatsapp: whatsapp ? { label: whatsapp, href: `https://wa.me/${whatsapp.replace(/\D/g, '')}`, placeholder: false } : { label: '+62 000 0000 0000', href: null, placeholder: true },
    email: email ? { label: email, href: `mailto:${email}`, placeholder: false } : { label: 'hello@balivillas.id', href: null, placeholder: true },
  }
}

export interface SearchValues {
  location: string
  checkIn: string
  checkOut: string
  guests: number
}

export const searchQuery = (v: SearchValues) => new URLSearchParams({ location: v.location, checkIn: v.checkIn, checkOut: v.checkOut, guests: String(v.guests) }).toString()
