# Rates Simulation

How to:

    npm install
    node sim.mjs rates/starsavior_20260406_standard.yaml        --runs 100000 --rarity-spread SSR all 4 --output reports/AllSSR   --title "Acquire All SSRs"
    node sim.mjs rates/starsavior_20260406_standard.yaml        --runs 100000 --rarity-spread SSR all 4 --output reports/4xAllSSR --title "Acquire 4x Of Each SSR"
    node sim.mjs rates/starsavior_20260406_standard.yaml        --runs 100000 --rarity-spread SSR 4 4   --output reports/4xAnySSR --title "Acquire 4x Of Any 4x SSRs"

    node sim.mjs rates/starsavior_20260406_standard.yaml        --runs 100000 --rarity-spread SR all 1  --output reports/AllSR    --title "Acquire All SRs"
    node sim.mjs rates/starsavior_20260406_standard.yaml        --runs 100000 --rarity-spread SR all 4  --output reports/4xAllSR  --title "Acquire 4x Of All SRs"

    node sim.mjs rates/starsavior_20260406_standard.yaml        --runs 100000 --rarity-spread SR all 1  --output reports/AllR     --title "Acquire All Rs"

    node sim.mjs rates/starsavior_20260406_standard.yaml        --runs 100000 --item "Asherah (Waltz of Starlight)" 2 --output reports/2xAsherahWaltzStandard        --title "Acquire 2x Asherah (Waltz of Starlight) Standard"
    node sim.mjs rates/starsavior_20260406_specialfeatured.yaml --runs 100000 --item "Asherah (Waltz of Starlight)" 2 --output reports/2xAsherahWaltzSpecialFeatured --title "Acquire 2x Asherah (Waltz of Starlight) Special Featured"
