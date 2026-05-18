const TIER_1_CITIES = new Set([
    'new delhi',
    'delhi',
    'mumbai',
    'bengaluru',
    'bangalore',
    'chennai',
    'kolkata',
    'hyderabad',
    'pune'
]);

export const CONTRIBUTOR_TRUST_POLICIES = {
    invite_pending: {
        label: 'Invite Pending',
        monthlyPayoutCapInr: 0,
        stage1HoldDays: 14,
        outcomeHoldDays: 45
    },
    scout: {
        label: 'Scout',
        monthlyPayoutCapInr: 3000,
        stage1HoldDays: 14,
        outcomeHoldDays: 45
    },
    verified: {
        label: 'Verified',
        monthlyPayoutCapInr: 7500,
        stage1HoldDays: 10,
        outcomeHoldDays: 35
    },
    elite: {
        label: 'Elite',
        monthlyPayoutCapInr: 15000,
        stage1HoldDays: 7,
        outcomeHoldDays: 21
    }
};

export const REWARD_STAGE_KEYS = {
    qualifiedProof: 'qualified_proof',
    confirmedActionable: 'confirmed_actionable',
    outcomeBonus: 'outcome_bonus'
};

export const seedContributors = () => ([
    {
        id: 'contrib_delhi_verified',
        inviteCode: 'DELHI-VERIFIED-2026',
        displayName: 'Delhi Verified Network',
        status: 'active',
        trustTier: 'verified',
        city: 'New Delhi',
        notes: 'Seeded invite-only contributor for rewards demos.',
        createdAt: new Date().toISOString()
    },
    {
        id: 'contrib_mumbai_scout',
        inviteCode: 'MUMBAI-SCOUT-2026',
        displayName: 'Mumbai Scout Network',
        status: 'active',
        trustTier: 'scout',
        city: 'Mumbai',
        notes: 'Seeded invite-only contributor for rewards demos.',
        createdAt: new Date().toISOString()
    }
]);

export const seedTariffTable = () => ([
    {
        id: 'tariff_iprs_t1_restaurant',
        orgId: 'org_collective_iprs',
        rightsLayer: 'collective',
        venueType: 'restaurant_bar_lounge',
        cityTier: 'tier_1',
        basis: 'annual',
        minimumFeeInr: 180000,
        sourceUrl: 'https://www.iprs.org/wp-content/uploads/TARIFF-RB.pdf',
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
        notes: 'Planning anchor for restaurants/bars in tier-1 cities.'
    },
    {
        id: 'tariff_iprs_t2_restaurant',
        orgId: 'org_collective_iprs',
        rightsLayer: 'collective',
        venueType: 'restaurant_bar_lounge',
        cityTier: 'tier_2',
        basis: 'annual',
        minimumFeeInr: 110000,
        sourceUrl: 'https://www.iprs.org/wp-content/uploads/TARIFF-RB.pdf',
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
        notes: 'Planning anchor for restaurants/bars outside tier-1 cities.'
    },
    {
        id: 'tariff_label_t1_standard',
        orgId: 'org_label_saregama',
        rightsLayer: 'label',
        venueType: 'restaurant_bar_lounge',
        cityTier: 'tier_1',
        basis: 'annual',
        minimumFeeInr: 85000,
        sourceUrl: 'https://www.pplindia.org/tariffs',
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
        notes: 'Planning anchor for label-side sound recording exposure.'
    },
    {
        id: 'tariff_label_t2_standard',
        orgId: 'org_label_saregama',
        rightsLayer: 'label',
        venueType: 'restaurant_bar_lounge',
        cityTier: 'tier_2',
        basis: 'annual',
        minimumFeeInr: 50000,
        sourceUrl: 'https://www.pplindia.org/tariffs',
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
        notes: 'Planning anchor for label-side sound recording exposure.'
    },
    {
        id: 'tariff_collective_event',
        orgId: 'org_collective_iprs',
        rightsLayer: 'collective',
        venueType: 'event_property',
        cityTier: 'tier_1',
        basis: 'event',
        minimumFeeInr: 350000,
        sourceUrl: 'https://www.novex.in/wp-content/uploads/2024/12/NYE-Rate-Card.pdf',
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
        notes: 'Event rights planning anchor.'
    },
    {
        id: 'tariff_label_event',
        orgId: 'org_label_saregama',
        rightsLayer: 'label',
        venueType: 'event_property',
        cityTier: 'tier_1',
        basis: 'event',
        minimumFeeInr: 400000,
        sourceUrl: 'https://www.novex.in/wp-content/uploads/2024/12/NYE-Rate-Card.pdf',
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
        notes: 'Event rights planning anchor.'
    }
]);

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
const cleanString = (value) => (value || '').trim().toLowerCase();

export const mergeSeedRecords = (existingRecords, seededRecords, key = 'id') => {
    const existing = Array.isArray(existingRecords) ? existingRecords : [];
    const merged = [...existing];

    for (const seededRecord of seededRecords) {
        if (!merged.some((record) => record[key] === seededRecord[key])) {
            merged.push(seededRecord);
        }
    }

    return merged;
};

export const getTrustTierPolicy = (trustTier) => CONTRIBUTOR_TRUST_POLICIES[trustTier] || CONTRIBUTOR_TRUST_POLICIES.invite_pending;

export const normalizeInviteCode = (value) => String(value || '').trim().toUpperCase();

export const getCityTier = (city) => (TIER_1_CITIES.has(cleanString(city)) ? 'tier_1' : 'tier_2');

export const inferVenueType = (merchantOrVenue) => {
    const joined = `${merchantOrVenue?.venueType || ''} ${merchantOrVenue?.name || ''} ${merchantOrVenue?.legalEntityName || ''}`.toLowerCase();

    if (joined.includes('hotel') || joined.includes('resort') || joined.includes('banquet')) {
        return 'hotel_banquet';
    }
    if (joined.includes('event') || joined.includes('lawn') || joined.includes('arena') || merchantOrVenue?.eventCapability === 'event-led') {
        return 'event_property';
    }
    if (joined.includes('cafe') || joined.includes('coffee')) {
        return 'small_cafe_qsr';
    }

    return 'restaurant_bar_lounge';
};

export const buildPlanningBand = (merchant) => {
    const venueType = inferVenueType(merchant);
    const outletCount = Number(merchant?.outletCount || 1);
    const hotelStarClass = Number(merchant?.hotelStarClass || 0);

    if (venueType === 'event_property') {
        return { key: 'major_event', label: 'Major event property', min: 350000, max: 500000 };
    }
    if (hotelStarClass >= 4 || outletCount >= 5 || venueType === 'hotel_banquet') {
        return { key: 'premium_hotel', label: '4/5-star hotel or premium event property', min: 300000, max: 1000000 };
    }
    if (hotelStarClass >= 3) {
        return { key: 'hotel_3_star', label: '3-star hotel or banquet-led venue', min: 150000, max: 400000 };
    }
    if (venueType === 'small_cafe_qsr') {
        return { key: 'small_cafe', label: 'Small cafe or QSR', min: 15000, max: 75000 };
    }

    return { key: 'restaurant_bar', label: 'Restaurant, bar, lounge, or pub', min: 75000, max: 250000 };
};

export const getCollectionProbability = (merchant) => {
    const band = buildPlanningBand(merchant);
    if (band.key === 'small_cafe') {
        return 0.25;
    }
    if (band.key === 'restaurant_bar') {
        return 0.4;
    }
    return 0.6;
};

export const getNonComplianceMultiplier = (licenseStatus) => {
    if (licenseStatus === 'expired') {
        return 1.15;
    }
    if (licenseStatus === 'unlicensed') {
        return 1.3;
    }
    return 1;
};

export const getStageOneAmount = () => 125;

export const getStageTwoAmount = (merchant) => {
    const band = buildPlanningBand(merchant);
    if (band.key === 'premium_hotel' || band.key === 'major_event') {
        return 600;
    }
    if (band.key === 'hotel_3_star' || band.key === 'restaurant_bar') {
        return 400;
    }
    return 250;
};

export const getOutcomeBonusRate = (merchant) => {
    const band = buildPlanningBand(merchant);
    if (band.key === 'premium_hotel' || band.key === 'major_event') {
        return 0.05;
    }
    if (band.key === 'hotel_3_star' || band.key === 'restaurant_bar') {
        return 0.03;
    }
    return 0.02;
};

export const getOutcomeBonusCap = (merchant) => {
    const band = buildPlanningBand(merchant);
    return band.key === 'premium_hotel' || band.key === 'major_event' ? 5000 : 1500;
};

export const calculateOutcomeBonus = ({ merchant, realizedValueInr }) => {
    const rate = getOutcomeBonusRate(merchant);
    const cap = getOutcomeBonusCap(merchant);
    return clamp(Math.round(Number(realizedValueInr || 0) * rate), 0, cap);
};

export const estimateRecoverableValue = ({ merchant, tariffs, licenseStatus }) => {
    const band = buildPlanningBand(merchant);
    const baseTariffTotal = tariffs.reduce((sum, tariff) => sum + Number(tariff.minimumFeeInr || 0), 0);
    const baseValue = baseTariffTotal || Math.round((band.min + band.max) / 2);
    const multiplier = getNonComplianceMultiplier(licenseStatus);
    const collectionProbability = getCollectionProbability(merchant);
    const estimatedValue = Math.round(baseValue * multiplier * collectionProbability);

    return {
        estimatedValueInr: clamp(estimatedValue, band.min, band.max),
        planningBand: band,
        nonComplianceMultiplier: multiplier,
        collectionProbability
    };
};

export const isStatusActionableForRewards = (status) => status === 'unlicensed' || status === 'expired';

export const buildRewardHoldDate = ({ createdAt = new Date(), holdDays }) => {
    const value = new Date(createdAt);
    value.setDate(value.getDate() + holdDays);
    return value.toISOString();
};
