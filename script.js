document.addEventListener('DOMContentLoaded', () => {
    // --- DOM ELEMENT REFERENCES ---
    const competitionSelect = document.getElementById('competition-select');
    const eventsList = document.getElementById('events-list');
    const welcomeMessage = document.getElementById('welcome-message');
    const eventView = document.getElementById('event-view');
    const inputPanel = document.getElementById('input-panel');
    const analysisPanel = document.getElementById('analysis-panel');
    const outputTableContainer = document.getElementById('output-table-container');
    const marketTypeFilter = document.getElementById('market-type-filter');

    let allCompetitions = [];
    let currentAnalysis = null;
    let selectedEvent = null;
    let debounceTimer;

    // --- API & DATA HANDLING ---
    const API_KEY = 'eyJhbGciOiJSUzI1NiIsImtpZCI6IkhKcDkyNnF3ZXBjNnF3LU9rMk4zV05pXzBrRFd6cEdwTzAxNlRJUjdRWDAiLCJ0eXAiOiJKV1QifQ.eyJhY2Nlc3NfdGllciI6InRyYWRpbmciLCJleHAiOjIwNjE1Mzc1MDIsImlhdCI6MTc0NjE3NzUwMiwianRpIjoiNTU1ODk0NjgtZjJhZi00ZGQ3LWE3MTQtZjNiNjgyMWU4OGRkIiwic3ViIjoiOGYwYTk5YTEtNTFhZi00YzJlLWFlNDUtY2MxNjgwNDVjZTc3IiwidGVuYW50IjoiY2xvdWRiZXQiLCJ1dWlkIjoiOGYwYTk5YTEtNTFhZi00YzJlLWFlNDUtY2MxNjgwNDVjZTc3In0.BW_nXSwTkxTI7C-1UzgxWLnNzo9Bo1Ed8hI9RfVLnrJa6sfsMyvQ1NrtT5t6i_emwhkRHU1hY-9i6c2c5AI4fc2mRLSNBujvrfbVHX67uB58E8TeSOZUBRi0eqfLBL7sYl1JNPZzhFkDBCBNFJZJpn40FIjIrtIiPd-G5ClaaSMRWrFUDiwA1NmyxHSfkfRpeRSnfk15qck7zSIeNeITzPbD7kZGDIeStmcHuiHfcQX3NaHaI0gyw60wmDgan83NpYQYRVLQ9C4icbNhel4n5H5FGFAxQS8IcvynqV8f-vz2t4BRGuYXBU8uhdYKgezhyQrSvX6NpwNPBJC8CWo2fA';

    async function fetchEventData() {
        const now = Math.floor(Date.now() / 1000);
        const oneWeekFromNow = now + (7 * 24 * 60 * 60);
        const url = `https://sports-api.cloudbet.com/pub/v2/odds/events?sport=soccer&from=${now}&to=${oneWeekFromNow}&live=false&markets=soccer.match_odds&markets=soccer.total_goals&markets=soccer.both_teams_to_score&limit=500`;

        try {
            const response = await fetch(url, { headers: { 'accept': 'application/json', 'X-API-Key': API_KEY } });
            if (!response.ok) throw new Error(`API Error: ${response.status}`);
            const data = await response.json();
            allCompetitions = data.competitions.map(comp => ({
                ...comp,
                events: comp.events.filter(e => e.markets['soccer.match_odds'] && e.markets['soccer.total_goals'] && e.markets['soccer.both_teams_to_score'])
            })).filter(comp => comp.events.length > 0);
            updateCompetitionSelect();
        } catch (error) {
            console.error("Failed to fetch data:", error);
            competitionSelect.innerHTML = `<option>Error loading data</option>`;
        }
    }

    // --- BIVARIATE POISSON CALCULATION ENGINE ---
    const oddsToProb = (odds) => (odds > 0 ? 1 / odds : 0);
    const probToOdds = (prob) => (prob > 0 ? 1 / prob : 0);
    const factorial = (n) => {
        if (n < 0) return 0;
        if (n === 0) return 1;
        let r = 1;
        for (let i = 2; i <= n; i++) r *= i;
        return r;
    };

    function normalizeProbabilities(probs) {
        const totalProb = probs.reduce((sum, p) => sum + p, 0);
        if (totalProb === 0) return probs.map(() => 1 / probs.length);
        return probs.map(p => p / totalProb);
    }

    function bivariatePoisson(x, y, lambda1, lambda2, lambda3) {
        if (lambda1 < 0 || lambda2 < 0) return 0;
        const term1 = Math.exp(-(lambda1 + lambda2 + lambda3));
        const term2 = Math.pow(lambda1, x) / factorial(x);
        const term3 = Math.pow(lambda2, y) / factorial(y);
        let sumTerm = 0;
        for (let i = 0; i <= Math.min(x, y); i++) {
            sumTerm += (factorial(x) * factorial(y) * Math.pow(lambda3 / (lambda1 * lambda2), i)) / (factorial(i) * factorial(x - i) * factorial(y - i));
        }
        return term1 * term2 * term3 * sumTerm;
    }

    function generateBivariateMatrix(l1, l2, l3, maxGoals = 8) {
        const matrix = [];
        for (let hg = 0; hg <= maxGoals; hg++) {
            matrix[hg] = [];
            for (let ag = 0; ag <= maxGoals; ag++) {
                matrix[hg][ag] = bivariatePoisson(hg, ag, l1, l2, l3);
            }
        }
        return matrix;
    }

    function calculateMarketsFromMatrix(csMatrix, homeLambda, awayLambda, prefix = '') {
        const markets = {};
        const maxGoals = csMatrix.length - 1;

        let pHome = 0, pDraw = 0, pAway = 0, pBttsYes = 0, pOdd = 0;
        let pHomeCleanSheet = 0, pAwayCleanSheet = 0;
        let pHomeWinToNil = 0, pAwayWinToNil = 0;

        for (let hg = 0; hg <= maxGoals; hg++) {
            for (let ag = 0; ag <= maxGoals; ag++) {
                const prob = csMatrix[hg][ag];
                if (hg > ag) pHome += prob;
                else if (ag > hg) pAway += prob;
                else pDraw += prob;

                if (hg > 0 && ag > 0) pBttsYes += prob;
                if ((hg + ag) % 2 !== 0) pOdd += prob;
                if (ag === 0) pHomeCleanSheet += prob;
                if (hg === 0) pAwayCleanSheet += prob;
                if (hg > ag && ag === 0) pHomeWinToNil += prob;
                if (ag > hg && hg === 0) pAwayWinToNil += prob;
            }
        }
        markets[`${prefix}1X2`] = { Home: pHome, Draw: pDraw, Away: pAway };
        markets[`${prefix}Double Chance`] = { '1X': pHome + pDraw, 'X2': pAway + pDraw, '12': pHome + pAway };
        markets[`${prefix}Draw No Bet`] = { Home: pHome / (pHome + pAway), Away: pAway / (pHome + pAway) };
        markets[`${prefix}Both Teams To Score`] = { Yes: pBttsYes, No: 1 - pBttsYes };
        markets[`${prefix}Odd/Even`] = { Odd: pOdd, Even: 1 - pOdd };
        markets[`${prefix}Clean Sheet Home`] = { Yes: pHomeCleanSheet, No: 1 - pHomeCleanSheet };
        markets[`${prefix}Clean Sheet Away`] = { Yes: pAwayCleanSheet, No: 1 - pAwayCleanSheet };
        markets[`${prefix}Home Win to Nil`] = { Yes: pHomeWinToNil, No: 1 - pHomeWinToNil };
        markets[`${prefix}Away Win to Nil`] = { Yes: pAwayWinToNil, No: 1 - pAwayWinToNil };
        
        const pNoGoal = csMatrix[0][0];
        const pAnyGoal = 1 - pNoGoal;
        const totalLambda = homeLambda + awayLambda;
        let pFirstGoalHome = 0, pFirstGoalAway = 0;
        if (totalLambda > 0) {
            pFirstGoalHome = (homeLambda / totalLambda) * pAnyGoal;
            pFirstGoalAway = (awayLambda / totalLambda) * pAnyGoal;
        }
        markets[`${prefix}First Goal`] = { Home: pFirstGoalHome, Away: pFirstGoalAway, 'No Goal': pNoGoal };

        const ouLines = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5];
        ouLines.forEach(line => {
            let pOver = 0;
            for (let hg = 0; hg <= maxGoals; hg++) for (let ag = 0; ag <= maxGoals; ag++) {
                if (hg + ag > line) pOver += csMatrix[hg][ag];
            }
            markets[`${prefix}Over/Under ${line}`] = { Over: pOver, Under: 1 - pOver };
        });

        const ahLines = [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5];
        ahLines.forEach(line => {
            let pHome = 0;
            for (let hg = 0; hg <= maxGoals; hg++) for (let ag = 0; ag <= maxGoals; ag++) {
                if (hg + line > ag) pHome += csMatrix[hg][ag];
            }
            markets[`${prefix}Asian Handicap ${line > 0 ? '+' : ''}${line}`] = { Home: pHome, Away: 1 - pHome };
        });
        
        const ehLines = [-2, -1, 1, 2];
        ehLines.forEach(line => {
            let pHome = 0, pDraw = 0, pAway = 0;
             for (let hg = 0; hg <= maxGoals; hg++) for (let ag = 0; ag <= maxGoals; ag++) {
                if (hg + line > ag) pHome += csMatrix[hg][ag];
                else if (hg + line < ag) pAway += csMatrix[hg][ag];
                else pDraw += csMatrix[hg][ag];
            }
             markets[`${prefix}European Handicap ${line > 0 ? '+' : ''}${line}`] = { Home: pHome, Draw: pDraw, Away: pAway };
        });

        return markets;
    }

    function findParameters(normProbs, line) {
        let l1 = 1.5, l2 = 1.2, l3 = 0.1, minError = Infinity;
        for (let i = 0; i < 50; i++) {
            let bestL1 = l1, bestL2 = l2, bestL3 = l3;
            for (let L1 = l1 - 0.2; L1 <= l1 + 0.2; L1 += 0.05)
            for (let L2 = l2 - 0.2; L2 <= l2 + 0.2; L2 += 0.05)
            for (let L3 = l3 - 0.1; L3 <= l3 + 0.1; L3 += 0.05) {
                if (L1 <= 0 || L2 <= 0) continue;
                const matrix = generateBivariateMatrix(L1, L2, L3);
                const modelProbs = calculateMarketsFromMatrix(matrix, L1, L2);
                
                // FIX: Dynamically get the Over probability based on the input line
                const modelOverProb = modelProbs[`Over/Under ${line}`]?.Over || 0;
                
                const err = Math.pow(modelProbs['1X2'].Home - normProbs.p1, 2) + 
                            Math.pow(modelProbs['1X2'].Draw - normProbs.pX, 2) + 
                            Math.pow(modelOverProb - normProbs.pOver, 2);

                if (err < minError) {
                    minError = err; bestL1 = L1; bestL2 = L2; bestL3 = L3;
                }
            }
            l1 = bestL1; l2 = bestL2; l3 = bestL3;
        }
        return { homeLambda: l1, awayLambda: l2, dependency: l3 };
    }

    function MarketMakerEngine(inputOdds) {
        const p1x2 = normalizeProbabilities([oddsToProb(inputOdds['1x2'].home), oddsToProb(inputOdds['1x2'].draw), oddsToProb(inputOdds['1x2'].away)]);
        const pOU = normalizeProbabilities([oddsToProb(inputOdds.totals.over), oddsToProb(inputOdds.totals.under)]);
        const pBtts = normalizeProbabilities([oddsToProb(inputOdds.btts.yes), oddsToProb(inputOdds.btts.no)]);
        const normProbs = { p1: p1x2[0], pX: p1x2[1], p2: p1x2[2], pOver: pOU[0], pBttsY: pBtts[0] };
        
        // Pass the dynamic goal line to the solver
        const ftParams = findParameters(normProbs, inputOdds.totals.line);
        const htParams = { homeLambda: ftParams.homeLambda * 0.44, awayLambda: ftParams.awayLambda * 0.44, dependency: ftParams.dependency * 0.44 };
        const stParams = { homeLambda: ftParams.homeLambda * 0.56, awayLambda: ftParams.awayLambda * 0.56, dependency: ftParams.dependency * 0.56 };

        const csMatrix_FT = generateBivariateMatrix(ftParams.homeLambda, ftParams.awayLambda, ftParams.dependency);
        const csMatrix_HT = generateBivariateMatrix(htParams.homeLambda, htParams.awayLambda, htParams.dependency);
        const csMatrix_ST = generateBivariateMatrix(stParams.homeLambda, stParams.awayLambda, stParams.dependency);
        
        const markets_FT = calculateMarketsFromMatrix(csMatrix_FT, ftParams.homeLambda, ftParams.awayLambda);
        const markets_HT = calculateMarketsFromMatrix(csMatrix_HT, htParams.homeLambda, htParams.awayLambda, '1H ');
        const markets_ST = calculateMarketsFromMatrix(csMatrix_ST, stParams.homeLambda, stParams.awayLambda, '2H ');

        let pHomeWinsBothHalves = markets_HT['1H 1X2'].Home * markets_ST['2H 1X2'].Home;
        let pAwayWinsBothHalves = markets_HT['1H 1X2'].Away * markets_ST['2H 1X2'].Away;
        let pHomeWinsEitherHalf = 1 - ((1 - markets_HT['1H 1X2'].Home) * (1 - markets_ST['2H 1X2'].Home));
        let pAwayWinsEitherHalf = 1 - ((1 - markets_HT['1H 1X2'].Away) * (1 - markets_ST['2H 1X2'].Away));
        
        markets_FT['Home to Win Both Halves'] = { Yes: pHomeWinsBothHalves, No: 1 - pHomeWinsBothHalves };
        markets_FT['Away to Win Both Halves'] = { Yes: pAwayWinsBothHalves, No: 1 - pAwayWinsBothHalves };
        markets_FT['Home to Win Either Half'] = { Yes: pHomeWinsEitherHalf, No: 1 - pHomeWinsEitherHalf };
        markets_FT['Away to Win Either Half'] = { Yes: pAwayWinsEitherHalf, No: 1 - pAwayWinsEitherHalf };

        let htft = { '1/1': 0, '1/X': 0, '1/2': 0, 'X/1': 0, 'X/X': 0, 'X/2': 0, '2/1': 0, '2/X': 0, '2/2': 0 };
        for (let hg1 = 0; hg1 <= 8; hg1++) for (let ag1 = 0; ag1 <= 8; ag1++) {
            for (let hg2 = 0; hg2 <= 8; hg2++) for (let ag2 = 0; ag2 <= 8; ag2++) {
                const ftHomeGoals = hg1 + hg2, ftAwayGoals = ag1 + ag2;
                const prob = csMatrix_HT[hg1][ag1] * csMatrix_ST[hg2][ag2];
                let htResult = (hg1 > ag1) ? '1' : (hg1 < ag1) ? '2' : 'X';
                let ftResult = (ftHomeGoals > ftAwayGoals) ? '1' : (ftHomeGoals < ftAwayGoals) ? '2' : 'X';
                htft[`${htResult}/${ftResult}`] += prob;
            }
        }
        markets_FT['Half Time/Full Time'] = htft;

        return {
            params: { fullTime: ftParams, halfTime: htParams, secondHalf: stParams },
            markets: { ...markets_FT, ...markets_HT, ...markets_ST }
        };
    }

    // --- UI RENDERING ---

    function updateCompetitionSelect() {
        competitionSelect.innerHTML = '<option value="" disabled selected>Select a competition</option>';
        allCompetitions.forEach(comp => {
            const option = document.createElement('option');
            option.value = comp.key;
            const keyParts = comp.key.split('-');
            const country = keyParts.length > 1 ? `[${keyParts[1].toUpperCase()}] ` : '';
            option.textContent = `${country}${comp.name}`;
            competitionSelect.appendChild(option);
        });
        competitionSelect.disabled = false;
        updateEventsList();
    }

    function updateEventsList() {
        const selectedKey = competitionSelect.value;
        const competition = allCompetitions.find(c => c.key === selectedKey);
        eventsList.innerHTML = '';
        if (competition) {
            competition.events.forEach(event => {
                const button = document.createElement('button');
                button.textContent = event.name;
                button.dataset.eventId = event.id;
                button.onclick = () => handleEventSelect(event);
                eventsList.appendChild(document.createElement('li')).appendChild(button);
            });
        }
    }

    function handleEventSelect(event) {
        document.querySelectorAll('.events-list button').forEach(btn => btn.classList.remove('active'));
        document.querySelector(`.events-list button[data-event-id='${event.id}']`).classList.add('active');
        
        selectedEvent = event;
        const findSelection = (selections, outcome) => selections.find(s => s.outcome === outcome);
        const findTotal = (selections, o, t) => selections.find(s => s.outcome === o && s.params === `total=${t}`);
        const ft = 'period=ft';
        
        const goalLinesToTry = ['2.5', '2.75', '3.5', '1.5', '3.0', '4.5'];
        let foundLine = '2.5';
        let overOdds = 0, underOdds = 0;
        for (const line of goalLinesToTry) {
            const over = findTotal(event.markets['soccer.total_goals'].submarkets[ft].selections, 'over', line);
            const under = findTotal(event.markets['soccer.total_goals'].submarkets[ft].selections, 'under', line);
            if (over && under) {
                foundLine = line; overOdds = over.price; underOdds = under.price;
                break;
            }
        }
        
        const inputs = {
            '1x2': {
                home: findSelection(event.markets['soccer.match_odds'].submarkets[ft].selections, 'home')?.price || 0,
                draw: findSelection(event.markets['soccer.match_odds'].submarkets[ft].selections, 'draw')?.price || 0,
                away: findSelection(event.markets['soccer.match_odds'].submarkets[ft].selections, 'away')?.price || 0,
            },
            'totals': { over: overOdds, under: underOdds, line: foundLine },
            'btts': {
                yes: findSelection(event.markets['soccer.both_teams_to_score'].submarkets[ft].selections, 'yes')?.price || 0,
                no: findSelection(event.markets['soccer.both_teams_to_score'].submarkets[ft].selections, 'no')?.price || 0,
            }
        };

        runFullAnalysis(inputs);
        welcomeMessage.classList.add('hidden');
        eventView.classList.remove('hidden');
    }

    function runFullAnalysis(inputs) {
        currentAnalysis = MarketMakerEngine(inputs);
        renderInputPanel(selectedEvent.name, selectedEvent.cutoffTime, inputs);
        renderAnalysisPanel(currentAnalysis.params);
        renderOutputTable();
    }
    
    function handleRecalculateWithDebounce() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            const inputs = {
                '1x2': {
                    home: parseFloat(document.getElementById('input-odds-home').value),
                    draw: parseFloat(document.getElementById('input-odds-draw').value),
                    away: parseFloat(document.getElementById('input-odds-away').value),
                },
                'totals': {
                    over: parseFloat(document.getElementById('input-odds-over').value),
                    under: parseFloat(document.getElementById('input-odds-under').value),
                    line: document.getElementById('goal-line-display').textContent,
                },
                'btts': {
                    yes: parseFloat(document.getElementById('input-odds-btts-yes').value),
                    no: parseFloat(document.getElementById('input-odds-btts-no').value),
                }
            };
            runFullAnalysis(inputs);
        }, 500);
    }

    function renderInputPanel(matchName, cutoffTime, inputs) {
        const kickoffDate = new Date(cutoffTime);
        const timeString = kickoffDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const dateString = kickoffDate.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

        inputPanel.innerHTML = `
            <div class="panel">
                <h3 class="match-name">${matchName}</h3>
                <p class="kickoff-time-display">${dateString}, ${timeString}</p>
                <div class="market-group">
                    <h4>1X2</h4>
                    <div class="market-row"><span>Home</span><input id="input-odds-home" type="number" step="0.01" value="${inputs['1x2'].home.toFixed(2)}"></div>
                    <div class="market-row"><span>Draw</span><input id="input-odds-draw" type="number" step="0.01" value="${inputs['1x2'].draw.toFixed(2)}"></div>
                    <div class="market-row"><span>Away</span><input id="input-odds-away" type="number" step="0.01" value="${inputs['1x2'].away.toFixed(2)}"></div>
                </div>
                <div class="market-group">
                    <h4>Total Goals (<span id="goal-line-display">${inputs.totals.line}</span>)</h4>
                    <div class="market-row"><span>Over</span><input id="input-odds-over" type="number" step="0.01" value="${inputs.totals.over.toFixed(2)}"></div>
                    <div class="market-row"><span>Under</span><input id="input-odds-under" type="number" step="0.01" value="${inputs.totals.under.toFixed(2)}"></div>
                </div>
                <div class="market-group">
                    <h4>BTTS</h4>
                    <div class="market-row"><span>Yes</span><input id="input-odds-btts-yes" type="number" step="0.01" value="${inputs.btts.yes.toFixed(2)}"></div>
                    <div class="market-row"><span>No</span><input id="input-odds-btts-no" type="number" step="0.01" value="${inputs.btts.no.toFixed(2)}"></div>
                </div>
            </div>
        `;
        inputPanel.querySelectorAll('input').forEach(input => {
            input.addEventListener('input', handleRecalculateWithDebounce);
        });
    }

    function renderAnalysisPanel(params) {
        const { fullTime, halfTime, secondHalf } = params;
        const ftExpectancy = fullTime.homeLambda + fullTime.awayLambda;
        const ftSupremacy = fullTime.homeLambda - fullTime.awayLambda;
        const htExpectancy = halfTime.homeLambda + halfTime.awayLambda;
        const stExpectancy = secondHalf.homeLambda + secondHalf.awayLambda;

        analysisPanel.innerHTML = `
            <div class="panel">
                <h3>Analysis</h3>
                <div class="analysis-row"><span>Home Lambda (FT)</span><span class="value">${fullTime.homeLambda.toFixed(3)}</span></div>
                <div class="analysis-row"><span>Away Lambda (FT)</span><span class="value">${fullTime.awayLambda.toFixed(3)}</span></div>
                <div class="analysis-row"><span>Goal Expectancy (FT)</span><span class="value">${ftExpectancy.toFixed(3)}</span></div>
                <div class="analysis-row"><span>Home Supremacy (FT)</span><span class="value">${ftSupremacy.toFixed(3)}</span></div>
                <div class="analysis-row"><span>Home Lambda (1H)</span><span class="value">${halfTime.homeLambda.toFixed(3)}</span></div>
                <div class="analysis-row"><span>Away Lambda (1H)</span><span class="value">${halfTime.awayLambda.toFixed(3)}</span></div>
                <div class="analysis-row"><span>Goal Expectancy (1H)</span><span class="value">${htExpectancy.toFixed(3)}</span></div>
                 <div class="analysis-row"><span>Goal Expectancy (2H)</span><span class="value">${stExpectancy.toFixed(3)}</span></div>
            </div>
        `;
    }

    function getMarketType(marketName) {
        if (marketName.includes('Over/Under') || marketName.includes('Both Teams To Score') || marketName.includes('Clean Sheet') || marketName.includes('Goal')) return 'Goals';
        if (marketName.includes('Handicap')) return 'Handicap';
        if (marketName.includes('Double Chance') || marketName.includes('Draw No Bet') || marketName.includes('Half Time/Full Time') || marketName.includes('Win to Nil') || marketName.includes('Win Both Halves') || marketName.includes('Win Either Half')) return 'Combo';
        if (marketName.includes('1X2')) return 'Main';
        if (marketName.includes('1H')) return 'Half';
        if (marketName.includes('2H')) return 'Half';
        return 'Main'; // Default
    }

    function renderOutputTable() {
        if (!currentAnalysis) {
            outputTableContainer.innerHTML = `<div class="placeholder"><p>No markets to display.</p></div>`;
            return;
        }
        
        const { markets } = currentAnalysis;
        
        let allMarkets = [];
        for (const marketName in markets) {
            for (const outcomeName in markets[marketName]) {
                const prob = markets[marketName][outcomeName];
                if (prob > 0 && prob < 1) {
                    allMarkets.push({
                        name: `${marketName.replace(/1H |2H /g, '')} - ${outcomeName}`,
                        type: getMarketType(marketName),
                        period: marketName.includes('1H') ? '1st Half' : (marketName.includes('2H') ? '2nd Half' : 'Full-Time'),
                        odds: probToOdds(prob),
                        prob: prob
                    });
                }
            }
        }

        const filter = marketTypeFilter.value;
        const filteredMarkets = filter === 'All' ? allMarkets : allMarkets.filter(m => m.type === filter || (filter === 'Half' && (m.period === '1st Half' || m.period === '2nd Half')));
        
        if (filteredMarkets.length === 0) {
            outputTableContainer.innerHTML = `<div class="placeholder"><p>No markets match the current filter.</p></div>`;
            return;
        }

        const groupedMarkets = filteredMarkets.reduce((acc, market) => {
            const key = market.period;
            if (!acc[key]) acc[key] = [];
            acc[key].push(market);
            return acc;
        }, {});

        let tableRows = '';
        const groupOrder = ['Full-Time', '1st Half', '2nd Half'];

        groupOrder.forEach(groupName => {
            if (groupedMarkets[groupName] && groupedMarkets[groupName].length > 0) {
                tableRows += `<tr class="market-separator"><td colspan="4">${groupName} Markets</td></tr>`;
                groupedMarkets[groupName].forEach(market => {
                    tableRows += `
                        <tr>
                            <td>${market.name}</td>
                            <td>${market.type}</td>
                            <td>${market.odds.toFixed(2)}</td>
                            <td>${(market.prob * 100).toFixed(2)}%</td>
                        </tr>
                    `;
                });
            }
        });

        outputTableContainer.innerHTML = `
            <table>
                <thead>
                    <tr><th>Market</th><th>Type</th><th>Fair Odds</th><th>Prob %</th></tr>
                </thead>
                <tbody>${tableRows}</tbody>
            </table>
        `;
    }

    // --- EVENT LISTENERS ---
    competitionSelect.addEventListener('change', updateEventsList);
    marketTypeFilter.addEventListener('change', renderOutputTable);
    
    // --- INITIALIZATION ---
    fetchEventData();
});
