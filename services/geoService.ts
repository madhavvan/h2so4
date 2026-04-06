// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GEO SERVICE — Country detection, VPN/proxy blocking
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface GeoData {
  ip: string;
  country_code: string;
  country_name: string;
  region: string;
  city: string;
  timezone: string;
  currency: string;
  is_proxy: boolean;
  is_vpn: boolean;
  threat_level: 'low' | 'medium' | 'high';
}

// Timezone → country mapping for cross-validation
const TIMEZONE_COUNTRY_MAP: Record<string, string[]> = {
  'America/New_York': ['US'], 'America/Chicago': ['US'], 'America/Denver': ['US'],
  'America/Los_Angeles': ['US'], 'America/Phoenix': ['US'], 'America/Anchorage': ['US'],
  'Pacific/Honolulu': ['US'], 'America/Indiana/Indianapolis': ['US'],
  'Asia/Kolkata': ['IN'], 'Asia/Calcutta': ['IN'],
  'Europe/London': ['GB'], 'Europe/Paris': ['FR'], 'Europe/Berlin': ['DE'],
  'Europe/Madrid': ['ES'], 'Europe/Rome': ['IT'], 'Europe/Amsterdam': ['NL'],
  'Asia/Tokyo': ['JP'], 'Asia/Shanghai': ['CN'], 'Asia/Seoul': ['KR'],
  'Asia/Singapore': ['SG'], 'Asia/Dubai': ['AE'],
  'Australia/Sydney': ['AU'], 'Australia/Melbourne': ['AU'],
  'America/Toronto': ['CA'], 'America/Vancouver': ['CA'],
  'America/Sao_Paulo': ['BR'], 'America/Mexico_City': ['MX'],
};

class GeoService {
  private cachedGeo: GeoData | null = null;
  private cacheExpiry: number = 0;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  async detectLocation(): Promise<GeoData> {
    if (this.cachedGeo && Date.now() < this.cacheExpiry) {
      return this.cachedGeo;
    }

    try {
      // Primary: ipapi.co (free, reliable, includes proxy detection)
      const response = await fetch('https://ipapi.co/json/', {
        headers: { 'Accept': 'application/json' },
      });

      if (!response.ok) throw new Error('Primary geo API failed');

      const data = await response.json();

      const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const timezoneCountries = TIMEZONE_COUNTRY_MAP[browserTimezone] || [];
      const ipCountry = data.country_code?.toUpperCase() || 'US';

      // VPN/Proxy detection heuristics
      const timezoneMatch = timezoneCountries.length === 0 || timezoneCountries.includes(ipCountry);
      const isProxy = data.proxy === true || data.hosting === true;
      const isVpn = !timezoneMatch || isProxy;

      // Threat assessment
      let threat_level: 'low' | 'medium' | 'high' = 'low';
      if (isProxy && !timezoneMatch) threat_level = 'high';
      else if (isProxy || !timezoneMatch) threat_level = 'medium';

      this.cachedGeo = {
        ip: data.ip || '',
        country_code: ipCountry,
        country_name: data.country_name || 'Unknown',
        region: data.region || '',
        city: data.city || '',
        timezone: data.timezone || browserTimezone,
        currency: data.currency || 'USD',
        is_proxy: isProxy,
        is_vpn: isVpn,
        threat_level,
      };

      this.cacheExpiry = Date.now() + this.CACHE_TTL;
      return this.cachedGeo;

    } catch (err) {
      // Fallback: use browser timezone to infer country
      const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const countries = TIMEZONE_COUNTRY_MAP[browserTimezone] || ['US'];

      this.cachedGeo = {
        ip: 'unknown',
        country_code: countries[0],
        country_name: 'Unknown',
        region: '',
        city: '',
        timezone: browserTimezone,
        currency: 'USD',
        is_proxy: false,
        is_vpn: false,
        threat_level: 'low',
      };

      this.cacheExpiry = Date.now() + this.CACHE_TTL;
      return this.cachedGeo;
    }
  }

  // WebRTC leak detection — exposes real IP behind VPN
  async detectWebRTCLeak(): Promise<{ leaked: boolean; realIPs: string[] }> {
    return new Promise((resolve) => {
      const ips: string[] = [];

      try {
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        });

        pc.createDataChannel('');

        pc.onicecandidate = (e) => {
          if (!e.candidate) {
            pc.close();
            resolve({ leaked: ips.length > 1, realIPs: ips });
            return;
          }

          const parts = e.candidate.candidate.split(' ');
          const ip = parts[4];
          if (ip && !ips.includes(ip) && !ip.includes(':')) {
            ips.push(ip);
          }
        };

        pc.createOffer().then((offer) => pc.setLocalDescription(offer));

        // Timeout after 3s
        setTimeout(() => {
          pc.close();
          resolve({ leaked: ips.length > 1, realIPs: ips });
        }, 3000);
      } catch {
        resolve({ leaked: false, realIPs: [] });
      }
    });
  }

  // Full security check — returns whether access should be blocked
  async performSecurityCheck(): Promise<{
    allowed: boolean;
    country_code: string;
    reason?: string;
    geo: GeoData;
  }> {
    const geo = await this.detectLocation();

    // High threat — block immediately
    if (geo.threat_level === 'high') {
      return {
        allowed: false,
        country_code: geo.country_code,
        reason: 'Connection flagged as high-risk proxy/VPN. Please disable VPN and try again.',
        geo,
      };
    }

    // Medium threat — allow with warning (timezone mismatch alone isn't definitive)
    if (geo.threat_level === 'medium') {
      // Still allow but flag for server-side verification
      return {
        allowed: true,
        country_code: geo.country_code,
        reason: 'partial_vpn_detected',
        geo,
      };
    }

    return { allowed: true, country_code: geo.country_code, geo };
  }
}

export const geoService = new GeoService();
