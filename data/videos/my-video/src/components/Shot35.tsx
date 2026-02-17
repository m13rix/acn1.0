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

export const Shot35: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline mapping: 11.57s total
	// Original landmarks: 0s, 3.3s, 6.6s (openings), 10s (all open)
	// Ratios: 0, 3.3/14, 6.6/14, 10/14
	const door1Start = 0;
	const door2Start = Math.round((3.3 / 14) * durationInFrames);
	const door3Start = Math.round((6.6 / 14) * durationInFrames);
	const allOpenTime = Math.round((10 / 14) * durationInFrames);

	// Door Opening Animations (Reveal behind)
	const open1 = interpolate(frame, [door1Start, door1Start + 30], [0, 100], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
		easing: Easing.inOut(Easing.quad),
	});
	const open2 = interpolate(frame, [door2Start, door2Start + 30], [0, 100], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
		easing: Easing.inOut(Easing.quad),
	});
	const open3 = interpolate(frame, [door3Start, door3Start + 30], [0, 100], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
		easing: Easing.inOut(Easing.quad),
	});

	// Text Overlays
	const text1Opacity = interpolate(frame, [door1Start + 15, door1Start + 30], [0, 1], {extrapolateLeft: 'clamp'});
	const text2Opacity = interpolate(frame, [door2Start + 15, door2Start + 30], [0, 1], {extrapolateLeft: 'clamp'});
	const text3Opacity = interpolate(frame, [door3Start + 15, door3Start + 30], [0, 1], {extrapolateLeft: 'clamp'});

	return (
		<AbsoluteFill style={{backgroundColor: '#111'}}>
			{/* Main Background Image */}
			<AbsoluteFill>
				<Img
					src={staticFile('three_doors_landscapes.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
				/>
			</AbsoluteFill>

			{/* Three Door Overlay Reveal Sections */}
			{/* We simulate "closed" doors with overlays that reveal the "landscapes" image underneath */}
			<div className="flex flex-row w-full h-full">
				{/* Door 1: ZAGS */}
				<div className="w-1/3 h-full relative">
					{/* Closed Door Mask */}
					<div 
						className="absolute inset-0 bg-gray-800 border-r-2 border-gray-600 z-10"
						style={{
							transform: `scaleX(${1 - open1 / 100})`,
							transformOrigin: 'left center',
						}}
					/>
					<AbsoluteFill className="justify-center items-center pb-20" style={{opacity: text1Opacity, zIndex: 20}}>
						<div className="bg-green-600/80 px-4 py-2 rounded text-white font-bold text-2xl uppercase shadow-lg">
							ЗАГС
						</div>
					</AbsoluteFill>
				</div>

				{/* Door 2: Court */}
				<div className="w-1/3 h-full relative">
					<div 
						className="absolute inset-0 bg-gray-800 border-r-2 border-gray-600 z-10"
						style={{
							transform: `scaleX(${1 - open2 / 100})`,
							transformOrigin: 'left center',
						}}
					/>
					<AbsoluteFill className="justify-center items-center pb-20" style={{opacity: text2Opacity, zIndex: 20}}>
						<div className="bg-blue-800/80 px-4 py-2 rounded text-white font-bold text-2xl uppercase shadow-lg">
							Суд
						</div>
					</AbsoluteFill>
				</div>

				{/* Door 3: Invalidity */}
				<div className="w-1/3 h-full relative">
					<div 
						className="absolute inset-0 bg-gray-800 z-10"
						style={{
							transform: `scaleX(${1 - open3 / 100})`,
							transformOrigin: 'left center',
						}}
					/>
					<AbsoluteFill className="justify-center items-center pb-20" style={{opacity: text3Opacity, zIndex: 20}}>
						<div className="bg-red-800/80 px-4 py-2 rounded text-white font-bold text-2xl uppercase shadow-lg text-center">
							Недействительность
						</div>
					</AbsoluteFill>
				</div>
			</div>

			{/* Comparison Highlight (Final segment) */}
			{frame > allOpenTime && (
				<AbsoluteFill 
					style={{
						border: '10px solid gold',
						opacity: 0.3,
						pointerEvents: 'none',
					}}
				/>
			)}

			<Audio src={staticFile('shot35_voice.mp3')} />
		</AbsoluteFill>
	);
};
