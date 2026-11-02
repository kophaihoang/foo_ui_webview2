# foo_dsp_automix

DSP cho foobar2000 v2 (x64): chuyển bài kiểu DJ.

- Chặng 1: chồng đuôi bài cũ với đầu bài mới, crossfade cân công suất, cắt dần bass bài cũ, bỏ im lặng ở hai đầu.
- Chặng 2: dò BPM, phách và đầu ô nhịp (qm-dsp), kéo dần tốc độ bài cũ cho khớp bài mới (SoundTouch), hai bài vào cùng ô nhịp, đổi bass ở ô nhịp giữa. Không hợp thì tự lùi về chặng 1.

Cài: lấy `foo_dsp_automix.fb2k-component` ở nhánh `automix-dll`, rồi Preferences → Components → Install.
Bật: Preferences → Playback → DSP Manager, đưa "AutoMix" lên đầu cột Active.
Chỉnh: Preferences → Advanced → Playback → AutoMix.
Nhật ký mỗi lần chuyển: View → Console, dòng bắt đầu bằng "AutoMix:".

Build: chạy `automix/fetch-libs.ps1` một lần để lấy qm-dsp và SoundTouch vào `automix/ext/`, rồi build `automix/foo_dsp_automix.sln`.

Giấy phép: GPL-3.0-or-later. Dùng qm-dsp (GPL-2.0-or-later) và SoundTouch (LGPL-2.1-or-later).
