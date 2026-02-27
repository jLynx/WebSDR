/* tslint:disable */
/* eslint-disable */

export class FFT {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * HackRF One の IQ サンプル列に対して複素 FFT を実行し、
     * スペクトログラムのウォーターフォール表示に必要な前処理を全て行う。
     *
     * このメソッドは以下の処理をワンパスで実行する：
     * 1. IQ サンプルの正規化（i8 → f32）
     * 2. 窓関数の適用
     * 3. 複素 FFT
     * 4. DC 中心配置への周波数軸の並べ替え
     * 5. 指数移動平均によるスムージング（設定時）
     * 6. dB スケールへの変換
     *
     * 出力された配列は、そのままスペクトログラムの1行（時刻 t におけるスペクトル）として
     * ウォーターフォール表示に使用できる。
     *
     * # 入力形式
     * * `input_` - i8の配列として表現された複素数列 `[re0, im0, re1, im1, ...]`
     *               長さは `self.n * 2` でなければならない
     *
     * # 出力形式
     * * `result` - 結果を格納するバッファ。長さは `self.n` でなければならない
     *   - `result[0 .. half_n]` - 負の周波数成分（DC中心配置、dBスケール）
     *   - `result[half_n .. n]` - 正の周波数成分（DC中心配置、dBスケール）
     *
     * # コントラクト（呼び出し側の責任）
     * * `input_.len() == self.n * 2` でなければならない
     * * `result.len() == self.n` でなければならない
     *
     * # 安全性
     * この関数は unsafe なメモリ再解釈を使用する。コントラクトに違反する場合、
     * 未定義動作を引き起こす可能性がある。
     */
    fft(input_: Int8Array, result: Float32Array): void;
    /**
     * 新しいFFTプロセッサを作成する。
     *
     * # 引数
     * * `n` - FFTサイズ。2の累乗であり、0より大きい必要がある
     * * `window_` - 窓関数の配列。長さは `n` と等しくなければならない
     *
     * # パニック
     * * `n` が 0 の場合
     * * `n` が 2の累乗でない場合
     * * `window_.len() != n` の場合
     */
    constructor(n: number, window_: Float32Array);
    set_smoothing_time_constant(val: number): void;
}

export function set_panic_hook(): void;
