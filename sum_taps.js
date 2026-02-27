const fs = require('fs');

const code = fs.readFileSync('a:\\Users\\jLynx\\Documents\\Code\\Websites\\hackrf-sweep-webusb\\hackrf-web\\src\\lib.rs', 'utf8');

const regex = /const (FIR_[A-Z0-9_]+): \&\[f32\] = \&\[([\s\S]*?)\];/g;
let match;
while ((match = regex.exec(code)) !== null) {
    const name = match[1];
    const vals = match[2].split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
    const sum = vals.reduce((a, b) => a + b, 0);
    console.log(name, sum);
}
