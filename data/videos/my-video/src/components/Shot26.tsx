import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
	Easing,
} from 'remotion';
import React from 'react';

export const Shot26: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 8.28s total
	// Original: 0-8s (Left), 8-16s (Right) -> Equal 50/50 split in terms of focus/appearance?
	// The prompt implies a sequence or a simultaneous split-screen where attention shifts.
	// "Split-screen" usually means both visible. "Left: ... (0-8s). Right: ... (8-16s)" might imply sequential animation or reveal.
	// I'll reveal Left then Right, maintaining both visible.
	
	const splitFrame = Math.round(durationInFrames / 2);

	// Left Side Animation: Mechanical Stamp
	// Vertical movement
	const stampY = interpolate(
		frame % 45, // Loop every 1.5s
		[0, 22, 45],
		[0, -30, 0],
		{easing: Easing.inOut(Easing.quad)}
	);

	// Reveal Animations
	const leftOpacity = interpolate(frame, [0, 20], [0, 1], {extrapolateRight: 'clamp'});
	const rightOpacity = interpolate(frame, [splitFrame, splitFrame + 20], [0, 1], {extrapolateRight: 'clamp'});

	// Right Side Animation: Slow push/zoom
	const rightScale = interpolate(
		frame - splitFrame,
		[0, durationInFrames - splitFrame],
		[1, 1.1],
		{extrapolateRight: 'clamp'}
	);

	// Text Overlay
	const textOpacity = interpolate(
		frame,
		[splitFrame + 10, splitFrame + 30],
		[0, 1],
		{extrapolateLeft: 'clamp'}
	);

	return (
		<AbsoluteFill style={{backgroundColor: '#101010'}}>
			<div className="flex flex-row w-full h-full">
				{/* Left Side: Passport Cold */}
				<div className="w-1/2 h-full relative overflow-hidden border-r-2 border-gray-800" style={{opacity: leftOpacity}}>
					<Img
						src={staticFile('passport_cold.png')}
						style={{
							width: '100%',
							height: '100%',
							objectFit: 'cover',
							transform: `translateY(${stampY}px)`,
						}}
					/>
					<div className="absolute top-0 left-0 w-full h-full bg-blue-900/20 mix-blend-overlay" />
				</div>

				{/* Right Side: Fake Marriage Table */}
				<div className="w-1/2 h-full relative overflow-hidden" style={{opacity: rightOpacity}}>
					<div style={{width: '100%', height: '100%', transform: `scale(${rightScale})`}}>
						<Img
							src={staticFile('fake_marriage_table.png')}
							style={{
								width: '100%',
								height: '100%',
								objectFit: 'cover',
								filter: 'grayscale(0.5) contrast(1.1)',
							}}
						/>
					</div>
				</div>
			</div>

			{/* Text Overlay */}
			<AbsoluteFill className="justify-center items-center">
				<div 
					className="bg-black/70 px-8 py-4 rounded-xl border-t-4 border-b-4 border-white"
					style={{opacity: textOpacity}}
				>
					<h2 
						className="text-white text-4xl font-bold uppercase tracking-wider"
						style={{fontFamily: 'Inter, sans-serif'}}
					>
						Фиктивность = цель ≠ семья
					</h2>
				</div>
			</AbsoluteFill>

			<Audio src={staticFile('shot26_voice.mp3')} />
		</AbsoluteFill>
	);
};
