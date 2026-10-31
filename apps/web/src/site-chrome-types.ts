export type SiteChromeLink = { id: string; label: string; href: string; enabled: boolean };
export type SiteChromeSocial = { id: string; platform: 'FACEBOOK' | 'INSTAGRAM' | 'LINKEDIN' | 'X' | 'YOUTUBE' | 'TIKTOK' | 'WHATSAPP' | 'PINTEREST' | 'WEBSITE' | 'OTHER'; url: string; label: string; enabled: boolean; display: 'ICON_AND_LABEL' | 'ICON_ONLY' };
export type SiteChromeConfiguration = {
  header: {
    template: 'CLASSIC' | 'EDITORIAL' | 'COMMERCE'; title: string; tagline: string; logoMediaId: string | null;
    backgroundColor: string; textColor: string; accentColor: string; alignment: 'LEFT' | 'CENTER'; sticky: boolean;
    showSearch: boolean; showCategoryLinks: boolean; density: 'COMPACT' | 'STANDARD' | 'SPACIOUS'; ctaLinkId: string | null;
    announcementEnabled: boolean; announcementText: string; announcementHref: string | null; navigation: SiteChromeLink[];
  };
  footer: {
    template: 'MINIMAL' | 'BUSINESS' | 'SIGNATURE'; title: string; description: string; logoMediaId: string | null;
    logoWidth: number; logoHeight: number; backgroundColor: string; textColor: string; accentColor: string; alignment: 'LEFT' | 'CENTER';
    sections: { id: string; title: string; links: SiteChromeLink[] }[]; socials: SiteChromeSocial[];
    contactEmail: string | null; contactPhone: string | null; copyright: string; backToTop: boolean;
  };
  suppressedPageKeys: string[];
};

export const defaultSiteChrome: SiteChromeConfiguration = {
  header: { template: 'CLASSIC', title: '', tagline: '', logoMediaId: null, backgroundColor: '#f5f5f0', textColor: '#18211d', accentColor: '#325a45', alignment: 'LEFT', sticky: true, showSearch: false, showCategoryLinks: false, density: 'STANDARD', ctaLinkId: null, announcementEnabled: false, announcementText: '', announcementHref: null, navigation: [] },
  footer: { template: 'MINIMAL', title: '', description: '', logoMediaId: null, logoWidth: 72, logoHeight: 48, backgroundColor: '#edf3ed', textColor: '#26342c', accentColor: '#325a45', alignment: 'LEFT', sections: [], socials: [], contactEmail: null, contactPhone: null, copyright: '', backToTop: false },
  suppressedPageKeys: []
};

export type SiteChromeBrand = { title: string; tagline?: string; description?: string; logoMediaId?: string | null; path?: string };
